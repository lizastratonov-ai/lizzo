const {
  QUEUE_PAGE_SIZE,
  buildActivePlayerCard,
  buildIdlePlayerCard,
  buildMovedPlayerCard,
  buildQueueManagerCard,
} = require("../ui/player-card");

class PlayerCardManager {
  constructor(client) {
    this.client = client;
    this.cards = new Map();
  }

  setPlayerMode(guildId) {
    return this.#mergeState(guildId, {
      mode: "player",
      queuePage: 0,
      selectedIndex: null,
    });
  }

  setQueueMode(guildId, queue) {
    const nextState = this.#normalizeQueueState(queue, {
      ...this.#getState(guildId),
      mode: "queue",
      queuePage: 0,
      selectedIndex: null,
    });

    this.cards.set(guildId, {
      ...this.#getState(guildId),
      ...nextState,
    });

    return nextState;
  }

  setQueuePage(guildId, queue, queuePage) {
    const nextState = this.#normalizeQueueState(queue, {
      ...this.#getState(guildId),
      mode: "queue",
      queuePage,
      selectedIndex: this.#getState(guildId).selectedIndex,
    });

    this.cards.set(guildId, {
      ...this.#getState(guildId),
      ...nextState,
    });

    return nextState;
  }

  setQueueSelectedIndex(guildId, queue, selectedIndex) {
    const requestedPage = Number.isInteger(selectedIndex) && selectedIndex > 0
      ? Math.floor((selectedIndex - 1) / QUEUE_PAGE_SIZE)
      : 0;

    const nextState = this.#normalizeQueueState(queue, {
      ...this.#getState(guildId),
      mode: "queue",
      queuePage: requestedPage,
      selectedIndex,
    });

    this.cards.set(guildId, {
      ...this.#getState(guildId),
      ...nextState,
    });

    return nextState;
  }

  getQueueViewState(guildId, queue) {
    const nextState = this.#normalizeQueueState(queue, this.#getState(guildId));

    this.cards.set(guildId, {
      ...this.#getState(guildId),
      ...nextState,
    });

    return nextState;
  }

  async renderQueue(queue) {
    const textChannel = queue.textChannel;
    if (!textChannel || typeof textChannel.send !== "function") {
      return null;
    }

    const state = this.getQueueViewState(queue.id, queue);
    const payload = state.mode === "queue"
      ? buildQueueManagerCard(queue, state)
      : buildActivePlayerCard(queue);

    return this.#upsert(queue.id, textChannel, payload, state);
  }

  async renderIdle({ guildId, textChannel, guildName, reason }) {
    const channel = await this.#resolveChannel(guildId, textChannel);

    if (!channel) {
      return null;
    }

    return this.#upsert(
      guildId,
      channel,
      buildIdlePlayerCard({ guildName, reason }),
      {
        mode: "player",
        queuePage: 0,
        selectedIndex: null,
      },
    );
  }

  async #resolveChannel(guildId, fallbackChannel) {
    if (fallbackChannel && typeof fallbackChannel.send === "function") {
      return fallbackChannel;
    }

    const stored = this.cards.get(guildId);
    if (!stored) {
      return null;
    }

    if (stored.channelRef && typeof stored.channelRef.send === "function") {
      return stored.channelRef;
    }

    const channel = await this.client.channels.fetch(stored.channelId).catch(() => null);
    if (!channel || typeof channel.send !== "function") {
      this.cards.delete(guildId);
      return null;
    }

    return channel;
  }

  async #upsert(guildId, textChannel, payload, statePatch = {}) {
    const stored = this.cards.get(guildId);

    if (stored && stored.channelId === textChannel.id) {
      const message = await this.#resolveStoredMessage(stored);
      if (message) {
        try {
          const updatedMessage = await message.edit(payload);
          this.#mergeState(guildId, {
            channelId: updatedMessage.channelId || updatedMessage.channel.id,
            messageId: updatedMessage.id,
            channelRef: textChannel,
            messageRef: updatedMessage,
            ...statePatch,
          });
          return updatedMessage;
        } catch (error) {
          if (!this.#isMissingMessage(error)) {
            console.warn("Failed to edit the shared player message:", error);
          } else {
            this.#mergeState(guildId, {
              messageId: null,
              messageRef: null,
              channelRef: textChannel,
            });
          }
        }
      }
    }

    if (stored && stored.channelId !== textChannel.id) {
      await this.#markPreviousCardAsMoved(stored, textChannel.id);
    }

    const sentMessage = await textChannel.send(payload);
    this.#mergeState(guildId, {
      channelId: textChannel.id,
      messageId: sentMessage.id,
      channelRef: textChannel,
      messageRef: sentMessage,
      ...statePatch,
    });
    return sentMessage;
  }

  async #resolveStoredMessage(stored) {
    if (!stored?.messageId) {
      return null;
    }

    if (stored.messageRef?.id === stored.messageId && typeof stored.messageRef.edit === "function") {
      return stored.messageRef;
    }

    const channel = stored.channelRef && typeof stored.channelRef.send === "function"
      ? stored.channelRef
      : await this.client.channels.fetch(stored.channelId).catch(() => null);

    if (!channel || !channel.messages) {
      return null;
    }

    const message = await channel.messages.fetch(stored.messageId).catch(() => null);
    if (!message) {
      return null;
    }

    return message;
  }

  async #markPreviousCardAsMoved(stored, nextChannelId) {
    const message = await this.#resolveStoredMessage(stored);
    if (!message) {
      return;
    }

    try {
      await message.edit(buildMovedPlayerCard({ channelId: nextChannelId }));
    } catch (error) {
      if (!this.#isMissingMessage(error)) {
        console.warn("Failed to mark the previous player message as moved:", error);
      }
    }
  }

  #isMissingMessage(error) {
    return error?.code === 10008 || error?.status === 404;
  }

  #getState(guildId) {
    return this.cards.get(guildId) || {};
  }

  #mergeState(guildId, patch) {
    const nextState = {
      ...this.#getState(guildId),
      ...patch,
    };

    this.cards.set(guildId, nextState);
    return nextState;
  }

  #normalizeQueueState(queue, stored = {}) {
    const upcomingCount = Math.max(queue.songs.length - 1, 0);
    const totalPages = Math.max(1, Math.ceil(upcomingCount / QUEUE_PAGE_SIZE));
    const queuePage = Math.min(Math.max(stored.queuePage || 0, 0), totalPages - 1);

    if (upcomingCount === 0) {
      return {
        mode: stored.mode === "queue" ? "queue" : "player",
        queuePage: 0,
        selectedIndex: null,
      };
    }

    const visibleStart = queuePage * QUEUE_PAGE_SIZE + 1;
    const visibleEnd = Math.min(visibleStart + QUEUE_PAGE_SIZE - 1, upcomingCount);
    const selectedIndex = Number.isInteger(stored.selectedIndex)
      && stored.selectedIndex >= visibleStart
      && stored.selectedIndex <= visibleEnd
        ? stored.selectedIndex
        : visibleStart;

    return {
      mode: stored.mode === "queue" ? "queue" : "player",
      queuePage,
      selectedIndex,
    };
  }
}

module.exports = {
  PlayerCardManager,
};

async function deferEphemeral(interaction) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ ephemeral: true });
  }
}

async function respond(interaction, options, ephemeral = true) {
  const payload = typeof options === "string" ? { content: options } : options;

  if (interaction.deferred || interaction.replied) {
    return interaction.editReply(payload);
  }

  return interaction.reply({ ...payload, ephemeral });
}

module.exports = {
  deferEphemeral,
  respond,
};

export class TelegramNotifier {
  constructor(config = {}) {
    this.botToken = config.botToken || '';
    this.chatId = config.chatId || '';
    this.enabled = !!(this.botToken && this.chatId);
    this.apiBase = `https://api.telegram.org/bot${this.botToken}`;
  }

  async send(text) {
    if (!this.enabled) return;
    try {
      await fetch(`${this.apiBase}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.chatId,
          text,
          parse_mode: 'HTML',
          disable_web_page_preview: true
        })
      });
    } catch (err) {
      console.error(`[Telegram] Send failed: ${err.message}`);
    }
  }

  async notifySnipe(event) {
    const { chain, token, result } = event;
    const confirmed = result?.confirmed || 0;
    const total = result?.total || 0;
    const errors = result?.errors || 0;

    let msg = `<b>⚡ SniperX — Snipe ${confirmed > 0 ? 'SUCCESS' : 'FAILED'}</b>\n\n`;
    msg += `Chain: <b>${chain}</b>\n`;
    msg += `Token: <code>${token}</code>\n`;
    msg += `Results: ${confirmed}/${total} confirmed`;
    if (errors > 0) msg += ` (${errors} errors)`;

    await this.send(msg);
  }

  async notifyMint(event) {
    const { target, result } = event;
    const confirmed = result?.confirmed || 0;
    const total = result?.total || 0;

    let msg = `<b>🖼 SniperX — NFT Mint ${confirmed > 0 ? 'SUCCESS' : 'FAILED'}</b>\n\n`;
    msg += `Label: <b>${target?.label || 'Unknown'}</b>\n`;
    msg += `Chain: ${target?.chain}\n`;
    msg += `Contract: <code>${target?.contractAddress}</code>\n`;
    msg += `Results: ${confirmed}/${total} confirmed`;

    await this.send(msg);
  }

  async notifyNewToken(event) {
    const { chain, token } = event;
    let msg = `<b>🔔 New Token Detected</b>\n\n`;
    msg += `Chain: ${chain}\n`;
    msg += `Symbol: <b>${token?.symbol || '?'}</b>\n`;
    msg += `Name: ${token?.name || 'Unknown'}\n`;
    msg += `Address: <code>${token?.address}</code>`;

    await this.send(msg);
  }

  async notifyError(context, error) {
    await this.send(`<b>❌ SniperX Error</b>\n\n${context}\n<code>${error}</code>`);
  }
}

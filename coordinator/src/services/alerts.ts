// ── Alert service ────────────────────────────────────────────────────
//
// Sends Slack notifications for protocol-critical failures.
// Set SLACK_WEBHOOK_URL env var to enable. If unset, alerts are logged only.

const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;

export async function sendAlert(title: string, detail: string): Promise<void> {
  const message = `[STRIKE ALERT] ${title}\n${detail}`;
  console.error(message);

  if (!SLACK_WEBHOOK_URL) return;

  try {
    const resp = await fetch(SLACK_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: message,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*${title}*\n\`\`\`${detail}\`\`\``,
            },
          },
        ],
      }),
    });
    if (!resp.ok) {
      console.error(`[alerts] Slack webhook returned ${resp.status}`);
    }
  } catch (err) {
    console.error(`[alerts] Failed to send Slack alert: ${err}`);
  }
}

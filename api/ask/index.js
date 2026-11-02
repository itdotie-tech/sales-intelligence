// IT.ie Command Centre — "Ask" assistant.
// Grounds an Azure OpenAI chat model on a snapshot of the dashboard's own
// computed figures (sent by the browser), so answers come from the live
// numbers rather than the raw feeds. Zero external dependencies: Node 18+
// global fetch + the Azure OpenAI REST API, keyed from app settings.
//   AOAI_ENDPOINT    e.g. https://itie-openai.openai.azure.com
//   AOAI_KEY         the resource key   (never in code or chat)
//   AOAI_DEPLOYMENT  the model deployment name, e.g. gpt-4-1-nano
//   AOAI_API_VERSION optional, defaults below

const SYS = [
  "You are the built-in assistant for IT.ie's internal \"Command Centre\" dashboard.",
  "Answer the user's question using ONLY the figures in the DATA object provided",
  "(revenue, Managed IT margin, cost to serve, support hours, CRM pipeline, owners, clients).",
  "All money is in euro (€). Be concise and specific: give the number first, then a one-line read.",
  "Definitions: Managed IT margin = Managed IT revenue minus cost to serve; cost to serve = non-billable",
  "support hours × the hourly rate; \"underwater\" = cost to serve exceeds the Managed IT fee.",
  "When helpful, point to the page to open (Profitability & Risk, Operations, CRM Overview,",
  "Pipeline Health, Lead Assignment, Multi-site). If the answer is not in DATA, say you don't have",
  "that figure in the current view rather than guessing. Never invent clients, owners or numbers."
].join(' ');

module.exports = async function (context, req) {
  const body = (req && req.body) || {};
  const question = String(body.question || '').slice(0, 1200).trim();
  const data = body.context || {};
  const json = o => ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o) });

  if (!question) { context.res = Object.assign({ status: 400 }, json({ error: 'No question.' })); return; }

  const ep = process.env.AOAI_ENDPOINT, key = process.env.AOAI_KEY, dep = process.env.AOAI_DEPLOYMENT;
  const ver = process.env.AOAI_API_VERSION || '2024-10-21';
  if (!ep || !key || !dep) {
    context.res = json({ notConfigured: true, answer: "The Ask assistant isn't switched on yet — the Azure OpenAI settings (AOAI_ENDPOINT, AOAI_KEY, AOAI_DEPLOYMENT) aren't saved on the app. Once your model is deployed and those four variables are set, this starts answering automatically." });
    return;
  }

  const url = ep.replace(/\/+$/, '') + '/openai/deployments/' + encodeURIComponent(dep) + '/chat/completions?api-version=' + encodeURIComponent(ver);
  const dataStr = JSON.stringify(data).slice(0, 26000); // keep the prompt bounded
  const payload = {
    messages: [
      { role: 'system', content: SYS },
      { role: 'user', content: 'DATA (the current dashboard figures):\n' + dataStr + '\n\nQUESTION: ' + question }
    ],
    temperature: 0.1,
    max_tokens: 700
  };

  const ac = new AbortController(); const to = setTimeout(() => ac.abort(), 25000);
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'api-key': key }, body: JSON.stringify(payload), signal: ac.signal });
    const text = await r.text().catch(() => '');
    if (!r.ok) {
      let msg = text.slice(0, 300);
      if (r.status === 401 || r.status === 403) msg = 'authentication failed — check AOAI_KEY and AOAI_ENDPOINT.';
      else if (r.status === 404) msg = 'deployment not found — check AOAI_DEPLOYMENT matches the model deployment name.';
      else if (r.status === 429) msg = 'the model is rate-limited or out of quota right now — try again shortly.';
      context.res = json({ error: true, answer: 'The assistant hit an error from Azure OpenAI (' + r.status + '): ' + msg });
      return;
    }
    let j = null; try { j = text ? JSON.parse(text) : null; } catch (e) {}
    const ans = (j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '(no answer returned)';
    context.res = json({ answer: ans });
  } catch (e) {
    const m = (e && e.name === 'AbortError') ? 'the request timed out.' : String(e && e.message || e);
    context.res = json({ error: true, answer: 'Could not reach Azure OpenAI: ' + m });
  } finally { clearTimeout(to); }
};

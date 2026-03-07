const PROMPT_PREFIX = (
  'Eres un generador de pistas para un juego. Para cada palabra de la lista, genera:\n' +
  '- pista_facil: UNA sola palabra, relación indirecta con la palabra original\n' +
  '- pista_dificil: UNA sola palabra, relación muy vaga o sorprendente\n\n' +
  'Responde ÚNICAMENTE con JSON válido, sin texto extra:\n' +
  '[{"word":"X","easy":"...","hard":"..."},...]\n\n'
);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { words } = req.body;
  if (!words || !Array.isArray(words) || words.length === 0) {
    return res.status(400).json({ error: 'words array is required' });
  }

  const prompt = PROMPT_PREFIX + `Palabras: ${words.join(', ')}`;
  const messages = [{ role: 'user', content: prompt }];
  const bytezKey = process.env.BYTEZ_API_KEY?.trim();
  const openaiKey = process.env.OPENAI_KEY?.trim();

  // 1) Bytez + gpt-4o-mini (necesita BYTEZ_API_KEY + OPENAI_KEY como provider-key)
  if (bytezKey && openaiKey) {
    const bytezRes = await fetch('https://api.bytez.com/models/v2/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': bytezKey,
        'provider-key': openaiKey,
      },
      body: JSON.stringify({
        model: 'openai/gpt-4o-mini',
        messages,
        max_tokens: 1024,
        temperature: 0.5,
      }),
    });
    if (bytezRes.ok) {
      const data = await bytezRes.json();
      return res.status(200).json(data);
    }
    console.error('[hints] Bytez gpt-4o-mini error:', bytezRes.status, await bytezRes.text());
  }

  // 2) Solo Bytez → modelo open-source (Qwen)
  if (bytezKey) {
    const bytezRes = await fetch('https://api.bytez.com/models/v2/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': bytezKey,
      },
      body: JSON.stringify({
        model: 'Qwen/Qwen3-4B',
        messages,
        max_tokens: 1024,
        temperature: 0.5,
      }),
    });
    if (bytezRes.ok) {
      const data = await bytezRes.json();
      return res.status(200).json(data);
    }
    console.error('[hints] Bytez Qwen error:', bytezRes.status, await bytezRes.text());
  }

  // 3) Solo OpenAI directo
  if (openaiKey) {
    const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${openaiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages,
      }),
    });
    if (openaiRes.ok) {
      const data = await openaiRes.json();
      return res.status(200).json(data);
    }
    const err = await openaiRes.text();
    return res.status(502).json({ error: `OpenAI error: ${openaiRes.status}`, detail: err });
  }

  return res.status(502).json({
    error: 'No AI provider configured',
    detail: 'Set BYTEZ_API_KEY or OPENAI_KEY in the environment.',
  });
}

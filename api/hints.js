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
  const body = {
    model: 'Qwen/Qwen3-4B',
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 1024,
    temperature: 0.5,
  };

  const bytezKey = process.env.BYTEZ_API_KEY?.trim();
  const openaiKey = process.env.OPENAI_KEY?.trim();

  if (bytezKey) {
    const bytezRes = await fetch('https://api.bytez.com/models/v2/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': bytezKey,
      },
      body: JSON.stringify(body),
    });
    if (bytezRes.ok) {
      const data = await bytezRes.json();
      return res.status(200).json(data);
    }
    const err = await bytezRes.text();
    console.error('[hints] Bytez error:', bytezRes.status, err);
  }

  if (openaiKey) {
    const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${openaiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
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

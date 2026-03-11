const PROMPT_PREFIX = (
  'Eres un generador de pistas para un juego. Para cada palabra de la lista, genera:\n' +
  '- pista_facil: UNA sola palabra, relación indirecta con la palabra original\n' +
  '- pista_dificil: UNA sola palabra, relación muy vaga o sorprendente\n\n' +
  'Responde ÚNICAMENTE con JSON válido, sin texto extra:\n' +
  '[{"word":"X","easy":"...","hard":"..."},...]\n\n'
);

export default async function handler(req, res) {
  // CORS: permitir cualquier origen (para que funcione web + app)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Peticiones preflight (antes del POST real)
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Solo aceptamos POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Validar body
  const { words } = req.body;
  if (!words || !Array.isArray(words) || words.length === 0) {
    return res.status(400).json({ error: 'words array is required' });
  }

  // Comprobar que tenemos la clave de OpenAI
  const openaiKey = process.env.OPENAI_KEY?.trim();
  if (!openaiKey) {
    return res.status(502).json({
      error: 'No AI provider configured',
      detail: 'Set OPENAI_KEY in the environment.',
    });
  }

  // Crear el prompt
  const prompt = PROMPT_PREFIX + `Palabras: ${words.join(', ')}`;

  // Llamar a OpenAI
  const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${openaiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 1024,
      temperature: 0.5,
    }),
  });

  // Comprobar respuesta de OpenAI
  if (!openaiRes.ok) {
    const err = await openaiRes.text();
    return res
      .status(502)
      .json({ error: `OpenAI error: ${openaiRes.status}`, detail: err });
  }

  // Devolver el JSON tal cual a la app
  const data = await openaiRes.json();
  return res.status(200).json(data);
}

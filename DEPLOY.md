# Deploy (Vercel + GitHub)

## Variables de entorno

**Nunca** subas la API key al repositorio. Configúrala en:

### Local
Copia `.env.example` a `.env` y rellena los valores:
```bash
cp .env.example .env
```
En `.env` añade al menos:
```
OPENAI_KEY=tu_key_de_openai
```
(Obtén la key en https://platform.openai.com/api-keys)

### Vercel
1. Proyecto → **Settings** → **Environment Variables**
2. Añade `OPENAI_KEY` con el valor de tu API key de OpenAI
3. Marca **Production**, **Preview**, **Development** si quieres que aplique en todos los entornos
4. Guarda y redeploy si ya tenías el proyecto desplegado

Con eso las pistas del juego usarán **gpt-4o-mini** en producción.

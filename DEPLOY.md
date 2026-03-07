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
BYTEZ_API_KEY=tu_key_de_bytez
```
(Obtén la key en https://bytez.com/api)

### Vercel
1. Proyecto → **Settings** → **Environment Variables**
2. Añade `BYTEZ_API_KEY` con valor `714461e2ec1aead0a43e3ebcc1208ebd` (o la key que uses)
3. Marca **Production**, **Preview**, **Development** si quieres que aplique en todos los entornos
4. Guarda y redeploy si ya tenías el proyecto desplegado

Con eso las pistas del juego usarán Bytez (modelo open-source) en producción.

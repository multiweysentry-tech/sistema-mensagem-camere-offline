# Servidor Baileys – Multiwey Sentry

Servidor **persistente** (24 h) que mantém a sessão do WhatsApp via Baileys, valida número antes de enviar, serializa envios com intervalo aleatório e avisa o painel sobre entrega/leitura/erro por webhook assinado.

O Baileys **não roda na Vercel**: ele exige WebSocket permanente e credenciais em disco. Este projeto roda em VPS, Railway, Render, Fly.io ou Docker.

```
Painel (Vercel / Express) ──HTTP + x-api-key──▶ wa-server ──▶ WhatsApp
                           ◀── webhook HMAC ────
```

## Versões

- Node **20+**
- `@whiskeysockets/baileys` **7.0.0-rc14** fixado (sem `^`). É a versão `latest` publicada no npm e a mesma família já usada pelo painel. A API usada aqui é a documentada para 7.x: `useMultiFileAuthState`, `saveCreds`, `sock.onWhatsApp`, `messages.update`, `messages.upsert`, `DisconnectReason.loggedOut`.

## Variáveis de ambiente

Copie `.env.example` para `.env` ou defina as variáveis na plataforma.

| Variável | Obrigatória | Padrão | Descrição |
|---|---|---|---|
| `API_KEY` | sim | — | Todas as rotas exigem `x-api-key` igual a este valor. Use uma chave longa e aleatória. |
| `SESSION_DIR` | não | `./session` | Pasta das credenciais do WhatsApp. **Deve estar em volume persistente.** |
| `WEBHOOK_URL` | recomendada | vazio | URL do painel, ex.: `https://seu-painel.vercel.app/api/whatsapp/webhook`. |
| `WEBHOOK_SECRET` | recomendada | vazio | Segredo HMAC compartilhado com o painel. Sem ele, os eventos não são assinados. |
| `HOST` | não | `0.0.0.0` | Endereço de escuta. |
| `PORT` | não | `3001` | Porta HTTP. |
| `QUEUE_MIN_DELAY_MS` | não | `3000` | Intervalo mínimo entre envios. |
| `QUEUE_MAX_DELAY_MS` | não | `8000` | Intervalo máximo entre envios. |
| `MAX_ENVIO_POR_MINUTO` | não | `20` | Teto de envios por janela deslizante de 60 s. |
| `LOG_LEVEL` | não | `info` | Nível do pino. |

## Rotas

Todas exigem o header `x-api-key`. Sem chave (ou chave errada): **401** `{ "erro": "Não autorizado" }`.

| Rota | Descrição |
|---|---|
| `GET /status` | `{ "status": "conectado" \| "desconectado" \| "aguardando_qr" }` |
| `GET /info` | Status, número mascarado, tamanho da fila (uso do painel). |
| `GET /qr` | Página HTML com o QR Code (atualiza a cada 15 s). Use `?json=1` ou `Accept: application/json` para receber `{ status, qr }`. |
| `POST /verificar` | `{ "numero": "5565999998888" }` → `{ ok, existe, numero, jid }`. Não envia mensagem. |
| `POST /enviar` | `{ "numero", "texto", "opcoes"?, "rodape"?, "metadata"? }` → `{ ok, id, queueId, status: "pendente", numero, jid }` (**202**). |

Regras de `POST /enviar`:

1. **503** se a sessão não estiver conectada.
2. Normalização: só dígitos, `55 + DDD + 9º dígito + número`. Números legados de 10 dígitos recebem o `9` apenas para a consulta; se não existirem no WhatsApp, a rota devolve **400**.
3. `sock.onWhatsApp()` valida o número; o **JID retornado** é usado no envio.
4. A mensagem entra na fila; a resposta já traz o `id` da mensagem e o `id` da fila. O envio real acontece depois, com intervalo aleatório e limite por minuto.

`opcoes` (opcional) são botões clicáveis `{ "id": "1", "text": "Estou verificando" }` (2 a 3 itens) — é o que a aba `#offline` usa para o responsável atualizar o status. `metadata` aceita `tenantId`, `instanceId` e `cameraIds`; esses dados voltam no webhook de status.

### Eventos enviados ao webhook

Header: `x-webhook-signature: sha256=<hmac_sha256_do_corpo_bruto_com_WEBHOOK_SECRET>`.

```json
{ "tipo": "status", "id": "sentry_...", "status": "enviada", "jid": "5565...@s.whatsapp.net", "timestamp": "...", "metadata": { "tenantId": "default", "cameraIds": ["CAM-1"] } }
```

Status mapeados: `enviada` (SERVER_ACK), `entregue` (DELIVERY_ACK), `lida` (READ/PLAYED), `erro` (ERROR). Mensagens recebidas (ignorando `fromMe`):

```json
{ "tipo": "mensagem", "id": "...", "remetente": "5565...@s.whatsapp.net", "texto": "Estou verificando", "timestamp": "..." }
```

## Deploy

### Docker (recomendado)

Build **na raiz do repositório** (o Dockerfile copia também `phone-utils.js`, a fonte única da normalização):

```bash
docker build -f wa-server/Dockerfile -t multiwey-wa-server .
mkdir -p wa-session
docker run -d --name wa-server --restart unless-stopped \
  --env-file wa-server/.env \
  -p 3001:3001 \
  -v "$PWD/wa-session:/app/session" \
  multiwey-wa-server
```

Use um **volume nomeado** em produção (`-v wa-session:/app/session`) para não perder a sessão ao recriar o container.

### Sem Docker (Railway/Render/Fly/VPS)

1. Crie um serviço Node 20 com o diretório de deploy apontando para `wa-server/` **ou** rode `npm install && npm start` dentro de `wa-server/`.
2. Defina todas as variáveis da tabela. Em plataformas com disco efêmero, anexe um volume persistente em `SESSION_DIR` — sem isso será preciso escanear o QR a cada deploy.
3. Aponte `WEBHOOK_URL` para `https://<painel>/api/whatsapp/webhook` e use **o mesmo** `WEBHOOK_SECRET` do painel.
4. Exponha a porta `3001` (ou a porta definida em `PORT`) apenas via HTTPS/reverse proxy; nunca publique sem `API_KEY`.

## Primeiro login por QR

1. Suba o servidor. O QR também é impresso no terminal (`printQRInTerminal`).
2. Com a chave em mãos, abra `https://wa-server.seu-dominio/qr` no navegador (ou `curl -H "x-api-key: $API_KEY" .../qr?json=1`).
3. No celular do **chip dedicado**, WhatsApp → aparelho conectado → escanear o QR.
4. Confirme: `curl -H "x-api-key: $API_KEY" https://wa-server.seu-dominio/status` → `{"status":"conectado"}`.
5. Se der `loggedOut`, o servidor apaga a pasta da sessão, avisa no log e gera um novo QR automaticamente.

## Backup da sessão

A sessão é a pasta apontada por `SESSION_DIR` (`creds.json`, `app-state-*.json`, etc.). Com o serviço parado:

```bash
tar czf backup-wa-session-$(date +%F).tar.gz -C /app session
```

Restaurando: pare o serviço, substitua o conteúdo da pasta e inicie novamente. **Nunca commite essa pasta** — ela contém credenciais do WhatsApp.

## Testes

```bash
cd wa-server && npm test
```

Os testes cobrem normalização, autenticação em tempo constante, fila/limite por minuto e assinatura HMAC sem abrir conexão com o WhatsApp.

## Riscos conhecidos

- A fila é **em memória**: mensagens aguardando são perdidas se o processo reiniciar. Para durabilidade, seriam necessários jobs no banco (fora deste escopo).
- Há **uma sessão por processo** (um chip). Para vários números, rode várias instâncias com `SESSION_DIR` e portas diferentes.
- A sessão usa o número conectado; não use o número principal da empresa nos testes.
- A confirmação de entrega depende do webhook chegar ao painel. Sem `WEBHOOK_URL`/`WEBHOOK_SECRET`, o painel mostrará "sem confirmação" após o timeout.

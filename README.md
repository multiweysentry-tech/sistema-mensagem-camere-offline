# Multiwey Sentry

Painel local para acompanhar câmeras offline, conversar pelo WhatsApp e executar bots de aviso e manutenção. Os dados operacionais ficam no PostgreSQL.

## Preparar e iniciar

1. Instale Node.js 22 ou superior e mantenha o container PostgreSQL `multiwey-postgres` em execução.
2. Crie o arquivo local de configuração a partir do exemplo:

   ```powershell
   Copy-Item .env.example .env
   ```

3. Preencha `PG_PASSWORD` no `.env` com a senha do PostgreSQL. Não compartilhe nem versione esse arquivo.
4. Inicie o painel:

   ```powershell
   npm install
   npm start
   ```

5. Abra http://127.0.0.1:3000 e confira o estado em http://127.0.0.1:3000/api/health.

O servidor escuta apenas em `127.0.0.1` por padrão. Para aceitar conexões de outras máquinas, configure uma `API_KEY` forte e um mecanismo de autenticação para o painel antes de mudar `HOST`; não exponha a porta diretamente à internet.

## Conectar o WhatsApp

1. No painel, abra **Central WhatsApp** e clique em **Conectar WhatsApp**.
2. No celular, abra WhatsApp → **Dispositivos conectados** → **Conectar dispositivo** e leia o QR Code.
3. Aguarde o estado **open** e confirme que conversas e mensagens aparecem na central.

A conexão por QR usa Baileys/WhatsApp Web, não a API oficial Meta. É uma integração não oficial e pode desconectar ou deixar de funcionar após mudanças no WhatsApp. Para operação comercial crítica, prefira a API oficial da Meta.

## Cadastro e avisos

- Ao cadastrar um responsável, o painel consulta o WhatsApp e bloqueia números que não existem na plataforma. Se a consulta estiver indisponível, o cadastro prossegue com aviso.
- O envio de avisos usa **opções clicáveis reais** no WhatsApp: **Em análise**, **Falar com técnico** e **Informei resolução**. Se o WhatsApp não aceitar os botões, o sistema envia texto com as opções `1`, `2` e `3`.
- As respostas dos botões (ou os números digitados) atualizam o status automaticamente.

## Bots e consentimento

- Os bots rodam de segunda a sexta-feira no fuso `America/Cuiaba`. Os horários, o limite de tentativas e o modo automático são configurados em **Config. Bots**.
- Antes do primeiro envio automático, confirme que o responsável autorizou as mensagens em **Config. Bots → Consentimento**.
- Os bots não enviam para contatos sem consentimento, bloqueados, fora do horário comercial ou que já receberam um aviso nas últimas 24 horas.
- O botão **Executar cobrança** e o botão **Executar lembrete** pedem confirmação antes de iniciar. Eles podem enviar mensagens reais aos contatos autorizados.
- Respostas `1`, `2`, `3` ou `PARAR` atualizam o atendimento. `PARAR` bloqueia novos envios automáticos.

O painel também permite responder manualmente às conversas recebidas. Mensagens manuais devem ser usadas em conversas legítimas com os contatos.

## Integração n8n

Os JSONs em `workflows/` são fluxos antigos para a API oficial Meta e permanecem inativos. Eles usam credenciais/configuração Cloud API que não fazem parte da conexão por QR. **Não ative esses fluxos junto com os bots locais**, para evitar caminhos de envio concorrentes.

## API principal

| Método | Rota | Descrição |
|---|---|---|
| `GET` | `/api/health` | Estado do backend e quantidade de câmeras |
| `GET` | `/api/cameras` | Lista e filtra câmeras |
| `POST` / `PUT` / `DELETE` | `/api/cameras` | Cadastro, atualização e remoção |
| `GET` / `POST` | `/api/log` | Consulta e grava eventos |
| `GET` / `POST` | `/api/whatsapp/status`, `/api/whatsapp/connect`, `/api/whatsapp/send` | Estado, conexão e envio pelo WhatsApp |
| `POST` | `/api/whatsapp/send-options` | Envio com opções clicáveis (com retorno para texto) |
| `GET` | `/api/whatsapp/check/:phone` | Verifica se o número existe no WhatsApp |
| `GET` | `/api/whatsapp/conversations` | Conversas armazenadas |
| `POST` | `/api/consent` | Registra ou remove autorização de mensagens |
| `POST` | `/api/bots/billing/run`, `/api/bots/maintenance/run` | Execução manual dos bots |

## Deploy na Vercel

O projeto possui um adaptador serverless em `api/index.js` e o `vercel.json` com rewrite de todas as rotas para ele. Configure o projeto da Vercel com **Framework Preset: Other**, **Build Command** e **Output Directory** vazios.

Defina estas variáveis de ambiente no projeto da Vercel (o `.env` local não é enviado ao GitHub):

- `PG_HOST`, `PG_PORT`, `PG_USER`, `PG_PASSWORD`, `PG_DATABASE` — o PostgreSQL precisa estar acessível pela rede; `127.0.0.1` não funciona na Vercel.
- Não defina `API_KEY` neste deploy: o painel não envia o cabeçalho `x-api-key` e todas as chamadas retornariam 401. Proteja o acesso com a **Password Protection** da Vercel ou restrição de IP.
- Para WhatsApp pela API oficial Meta: `META_WA_ACCESS_TOKEN` e `META_WA_PHONE_NUMBER_ID`.
- Para usar uma conexão Baileys local por meio seguro: `WHATSAPP_BRIDGE_URL` e opcionalmente `WHATSAPP_BRIDGE_KEY`.

**Sem Postgres remoto configurado**, o adaptador usa `db-memory.js`: o painel e as APIs respondem normalmente, mas os dados **não persistem** entre invocações/instâncias. O `/api/health` indica `"storage":"memory"`. Para persistência, configure as variáveis acima com um banco alcançável pela Vercel.

### Limitações do serverless

A Vercel executa funções sob demanda, sem processo persistente e com sistema de arquivos somente leitura. Por isso, estes recursos ficam limitados:

- Conexão/desconexão pelo WhatsApp Baileys (a integração oficial Meta ou uma ponte HTTPS pode fornecer envio serverless);
- Execução manual dos bots (depende da conexão WhatsApp);
- Atualizações em tempo real via Socket.IO (WebSocket não é suportado nas funções; o painel continua funcionando via requisições HTTP, mas sem push automático).

Para usar o sistema completo — WhatsApp, bots e atualizações em tempo real — execute `npm start` em um servidor com processo persistente (VPS, Railway, Render, Fly.io etc.), mantendo `HOST=127.0.0.1` atrás de um proxy reverso.

## Verificação

Execute `npm test` para rodar os testes automatizados. Os testes usam um banco em memória e não enviam mensagens reais.

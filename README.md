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

- Ao cadastrar um responsável, o painel valida o DDD brasileiro (com ou sem DDI `55`) e consulta o WhatsApp, bloqueando números inexistentes. Se a consulta estiver indisponível, o cadastro prossegue com aviso.
- O envio de avisos usa opções clicáveis para o cliente no WhatsApp: **Estou verificando**, **Preciso de suporte** e **Já resolvi**. Se o WhatsApp não aceitar as opções interativas, o envio falha explicitamente em vez de registrar como enviado um texto sem botões.
- As respostas dos botões (ou os números digitados) atualizam o status automaticamente.

## Bots e consentimento

- Os bots rodam de segunda a sexta-feira no fuso `America/Cuiaba`. Os horários, o limite de tentativas e o modo automático são configurados em **Config. Bots**.
- Uma janela de horário temporária pode ser configurada por data; ela usa o fuso `America/Cuiaba` e deixa de valer automaticamente após a meia-noite da data informada.
- O cadastro de uma câmera registra o consentimento informado para o responsável, desde que não exista opt-out ou bloqueio anterior. Contatos já cadastrados sem registro de consentimento também são atualizados na inicialização do banco.
- Se um responsável pedir para parar, a resposta `PARAR` bloqueia novos envios. Um opt-out ou bloqueio existente não é removido por novos cadastros; só reative o contato após uma nova autorização, em **Config. Bots → Consentimento**.
- A confirmação de entrega vem do receipt do aparelho destinatário (`DELIVERY_ACK`, status `3`), capturado em `messages.update` e no callback bruto `CB:receipt`. O envio interativo usa apenas o nó `<biz>` para renderizar os botões; **não** incluir `<bot biz_bot="1">`, porque mensagens marcadas como bot não geram receipt de entrega e ficariam presas em `unconfirmed`.
- Se o WhatsApp aceitar o relay mas não confirmar a entrega em 12 segundos, o painel registra o envio como não confirmado, mostra-o na Central WhatsApp e não marca a câmera como notificada. Confira a conversa/aparelho antes de reenviar; a tentativa fica protegida contra duplicação automática por 24 horas.
- O painel e o backend permitem apenas um envio interativo por contato de cada vez, evitando envios duplicados enquanto aguardam a confirmação.
- Os bots não enviam para contatos sem consentimento, bloqueados ou fora do horário comercial. O log e a data do último aviso na câmera impedem novas tentativas por 24 horas, inclusive quando o log está indisponível; falhas recentes também evitam repetição automática.
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
| `POST` | `/api/whatsapp/send-options` | Envio com opções clicáveis |
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

O painel publicado na Vercel não mantém a sessão do WhatsApp conectada por QR. Para usar seu próprio WhatsApp e os bots Baileys, abra `http://127.0.0.1:3000` no computador onde o servidor persistente está em execução, ou hospede o backend em uma VPS/serviço persistente. O estado `configured` na Vercel confirma apenas que há credenciais de envio; não confirma conexão nem entrega.

**Sem Postgres remoto configurado**, o adaptador usa `db-memory.js`: o painel e as APIs respondem normalmente, mas os dados **não persistem** entre invocações/instâncias. O `/api/health` indica `"storage":"memory"`. Para persistência, configure as variáveis acima com um banco alcançável pela Vercel.

### Limitações do serverless

A Vercel executa funções sob demanda, sem processo persistente e com sistema de arquivos somente leitura. Por isso, estes recursos ficam limitados:

- Conexão/desconexão pelo WhatsApp Baileys (a integração oficial Meta ou uma ponte HTTPS pode fornecer envio serverless);
- Execução manual dos bots (depende da conexão WhatsApp);
- Atualizações em tempo real via Socket.IO (WebSocket não é suportado nas funções; o painel continua funcionando via requisições HTTP, mas sem push automático).

Para usar o sistema completo — WhatsApp, bots e atualizações em tempo real — execute `npm start` em um servidor com processo persistente (VPS, Railway, Render, Fly.io etc.), mantendo `HOST=127.0.0.1` atrás de um proxy reverso.

## Verificação

Execute `npm test` para rodar os testes automatizados. Os testes usam um banco em memória e não enviam mensagens reais.

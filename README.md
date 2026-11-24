# Multiwey Sentry

Plataforma local para acompanhar câmeras offline, conversar pelo WhatsApp e executar bots de aviso e manutenção. Suporta múltiplas instâncias WhatsApp isoladas, autenticação com tenants, fila persistente e diagnóstico. Os dados operacionais ficam no PostgreSQL.

## Preparar e iniciar

1. Instale Node.js 22 ou superior e mantenha o PostgreSQL local em execução (`127.0.0.1:5433` por padrão).
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

O servidor escuta apenas em `127.0.0.1` por padrão. Antes de mudar `HOST`, configure `ADMIN_EMAIL` e `ADMIN_PASSWORD` — fora de loopback o servidor se recusa a iniciar sem essas variáveis. Não exponha a porta diretamente à internet; use um proxy reverso com HTTPS.

## Autenticação e tenants

- Defina `ADMIN_EMAIL`, `ADMIN_PASSWORD` (mínimo recomendado: 10 caracteres) e, opcionalmente, `ADMIN_TENANT` no `.env`. Na primeira inicialização, um usuário administrador é criado para esse tenant.
- O login cria um cookie `HttpOnly` com validade de 12 horas. Senhas são armazenadas com `scrypt`; tokens de sessão são salvos apenas como hash no banco.
- Em loopback, sem `ADMIN_EMAIL`/`ADMIN_PASSWORD`, o acesso continua aberto e o servidor registra um aviso no log. Isso existe apenas para desenvolvimento local.
- Cada usuário pertence a um tenant. Câmeras, logs, conversas, mensagens, consentimento, bloqueios, modelos, configuração dos bots, instâncias e tarefas são filtrados pelo tenant do usuário autenticado.
- O botão **Sair** encerra a sessão. Não há credenciais em `localStorage` ou `sessionStorage`.

## Instâncias WhatsApp

A aba **Instâncias** permite usar mais de um número no mesmo servidor:

1. Informe um identificador (ex.: `filial_2`) e clique em **Criar instância**.
2. Clique em **Conectar** ou **Novo QR** e leia o QR Code no WhatsApp → **Dispositivos conectados** → **Conectar dispositivo**.
3. Use **Selecionar** para escolher a instância ativa na Central WhatsApp e no envio manual.

Detalhes importantes:

- A instância `default` é criada automaticamente no startup e reaproveita o diretório `auth_info` existente.
- Cada instância não-default guarda suas credenciais em `auth_info/<id>`.
- **Desconectar** pausa a sessão e preserva as credenciais. **Excluir sessão** faz logout e apaga o diretório daquela instância — use somente quando quiser desparear o dispositivo.
- A reconexão automática usa backoff com jitter e para após 8 tentativas; a reconexão manual zera a contagem.
- Cada instância executa seus bots com locks próprios, evitando que a mesma campanha seja enviada duas vezes.
- A conexão por QR usa Baileys/WhatsApp Web, não a API oficial Meta. É uma integração não oficial e pode desconectar ou deixar de funcionar após mudanças no WhatsApp. Não há garantia de estabilidade. Para operação comercial crítica, prefira a API oficial da Meta. Não implementamos evasão de limites ou mecanismos antispam do WhatsApp.

## WhatsApp Cloud API oficial

O adaptador oficial funciona no servidor local ou no deploy Vercel. Para testar sem mexer no número que já está ativo no aplicativo móvel, comece pelo número de teste oferecido no painel Meta:

1. No Meta for Developers, crie/configure um app com o produto WhatsApp e use o **Phone Number ID** e um token de acesso com `whatsapp_business_messaging` e `whatsapp_business_management`. No modo de teste, adicione e confirme o telefone destinatário permitido pela Meta.
2. Crie e envie para aprovação um template de categoria **Utility**, idioma `pt_BR`, chamado `sentry_camera_offline` (ou outro nome definido em `META_WA_TEMPLATE_NAME`). O corpo deve conter exatamente um parâmetro `{{1}}`, por exemplo: `O Sentry identificou estas câmeras offline: {{1}}. Escolha uma opção abaixo para atualizar o status.` Inclua três botões de resposta rápida: **Estou verificando**, **Preciso de suporte** e **Já resolvi**.
3. Configure as variáveis no `.env` local ou nas variáveis de ambiente do projeto Vercel, sem compartilhar nem versionar os valores:

   ```dotenv
   WHATSAPP_PROVIDER=meta
   META_WA_ACCESS_TOKEN=...
   META_WA_PHONE_NUMBER_ID=...
   META_WA_GRAPH_VERSION=v27.0
   META_WA_TEMPLATE_NAME=sentry_camera_offline
   META_WA_TEMPLATE_LANGUAGE=pt_BR
   META_WA_APP_SECRET=...
   META_WA_VERIFY_TOKEN=...
   META_WA_TENANT_ID=default
   ```

4. Configure o callback HTTPS e mantenha o destino ativo:
   - **Servidor local:** use um túnel HTTPS que encaminhe para a porta local 3000 e cadastre `https://SEU_TUNEL/api/whatsapp/meta/webhook`.
   - **Vercel:** cadastre `https://SEU_DOMINIO_VERCEL/api/whatsapp/meta/webhook` como callback. Para este projeto, o endereço informado é `https://sistema-mensagem-camere-offline.vercel.app/api/whatsapp/meta/webhook`.
   Nos dois casos, use o mesmo `META_WA_VERIFY_TOKEN`, assine o campo `messages` e configure `META_WA_APP_SECRET` para validar a assinatura HMAC. Reinicie o servidor local ou redeploy a Vercel depois de alterar as variáveis.
5. Teste primeiro com o número de teste e um contato autorizado no painel Meta. Não desconecte nem migre o número ativo no aplicativo móvel. A conexão oficial não usa QR. Os bots locais usam o template aprovado; mensagens de texto livres só podem ser enviadas dentro da janela de atendimento permitida pela Meta.

O envio fica como pendente até chegar um status de entrega pelo webhook. Sem URL HTTPS pública, token/verificação configurados e assinatura `messages`, envios podem ser aceitos pela API, mas entregas e respostas não serão sincronizadas com o painel.
`META_WA_TENANT_ID` define o tenant associado às respostas recebidas (use `default` em uma instalação simples). O servidor exige o App Secret e o token de verificação para iniciar esse provider.
Na Vercel, configure também um PostgreSQL remoto: o banco em memória não persiste entre invocações e não é adequado para correlacionar os envios com os webhooks.

## WhatsApp pela Datafy

O provider `datafy` usa a API oficial da Meta através da Datafy. O token `sk_live_` é enviado somente no header `Authorization`; o `phone_number_id` é consultado em `GET https://cloud.datafyapi.com.br/me` se não for configurado explicitamente. O UUID do canal não substitui esse ID e não é necessário para enviar mensagens.

Configure as variáveis como Secrets no ambiente Production da Vercel (e no `.env` local, se aplicável):

```dotenv
WHATSAPP_PROVIDER=datafy
DATAFY_WA_ACCESS_TOKEN=...
DATAFY_WA_WEBHOOK_SECRET=...
DATAFY_WA_TEMPLATE_NAME=sentry_camera_offline
DATAFY_WA_TEMPLATE_LANGUAGE=pt_BR
DATAFY_WA_TENANT_ID=default
```

`DATAFY_WA_WEBHOOK_SECRET` é o segredo `whsec_...` exibido na aba Webhooks do canal Datafy; ele é diferente do token `sk_live_`. Cadastre nessa aba o callback `https://SEU_DOMINIO/api/whatsapp/datafy/webhook` com o evento `messages`. A integração valida a assinatura HMAC da Datafy e os timestamps, e só marca a mensagem como entregue após receber o status correspondente. Mensagens livres dependem da janela de atendimento de 24 horas; fora dela, use um template aprovado. Para bots com botões, configure um template Utility aprovado contendo `{{1}}` e os três botões padrão descritos acima.

O envio aceito pela API não prova entrega. Sem o webhook assinado, os envios permanecem pendentes. Se um token `sk_live_` foi compartilhado fora de um cofre de segredos, revogue/rotacione-o na Datafy antes de adicioná-lo à Vercel; nunca o coloque no código, Git ou chat.

## Central WhatsApp e diagnóstico

- A aba **Central WhatsApp** mostra conversas e mensagens da instância selecionada, com envio manual e atualização em tempo real via Socket.IO no servidor local.
- A aba **Diagnóstico** mostra o estado da API, das instâncias e as últimas tarefas da fila, incluindo erros. Ela existe para investigar falhas com dados reais, não para exibir números fictícios.

## Fila persistente

As tarefas ficam na tabela `jobs` e são processadas por um worker no mesmo processo do servidor:

- Idempotência por `(tenant_id, idempotency_key)`: o mesmo trabalho não é enfileirado duas vezes.
- Concorrência segura com `FOR UPDATE SKIP LOCKED` no Postgres.
- Retry controlado; após esgotar as tentativas, a tarefa fica como `failed` e o erro aparece no diagnóstico.
- Handlers registrados: `send_text`, `send_options`, `run_billing` e `run_maintenance`.
- `GET /api/jobs` consulta o estado da fila; a interface usa essa rota para o diagnóstico.

Sem Postgres, o adaptador serverless usa uma fila em memória apenas para não quebrar a API — ela não sobrevive a reinícios.

## Cadastro e avisos

- Ao cadastrar um responsável, o painel valida o DDD brasileiro (com ou sem DDI `55`) e consulta o WhatsApp, bloqueando números inexistentes. Se a consulta estiver indisponível, o cadastro prossegue com aviso.
- Toda normalização de telefone usa a única regra em `phone-utils.js` (compartilhada pelo painel): aceita JID `@s.whatsapp.net`/`@c.us`, máscara, zero à esquerda e número sem DDI. A chave de comparação `DDD + últimos 8 dígitos` cruza o contato do WhatsApp com o cadastro mesmo quando o 9º dígito não foi informado; o 9º dígito não é inventado no cadastro. No envio pelo servidor Baileys persistente, números legados de 10 dígitos recebem o 9º dígito apenas para a consulta no WhatsApp — se o número não existir, o envio é recusado com 400.
- O envio de avisos usa opções clicáveis para o cliente no WhatsApp: **Estou verificando**, **Preciso de suporte** e **Já resolvi**. Se o WhatsApp não aceitar as opções interativas, o envio falha explicitamente em vez de registrar como enviado um texto sem botões.
- As respostas dos botões (ou os números digitados) atualizam o status automaticamente.
- A confirmação de entrega vem do receipt do aparelho destinatário (`DELIVERY_ACK`, status `3`), capturado em `messages.update` e no callback bruto `CB:receipt`. O envio interativo usa apenas o nó `<biz>` para renderizar os botões; **não** incluir `<bot biz_bot="1">`, porque mensagens marcadas como bot não geram receipt de entrega e ficariam presas em `unconfirmed`.
- Se o WhatsApp aceitar o relay mas não confirmar a entrega em 12 segundos, o painel registra o envio como não confirmado e não marca a câmera como notificada. A tentativa fica protegida contra duplicação automática por 24 horas.
- O painel e o backend permitem apenas um envio interativo por contato e instância de cada vez.

## Bots e consentimento

- Os bots rodam de segunda a sexta-feira no fuso `America/Cuiaba`, separadamente por tenant e instância. Os horários, o limite de tentativas e o modo automático são configurados em **Config. Bots**.
- Uma janela de horário temporária pode ser configurada por data; ela usa o fuso `America/Cuiaba` e deixa de valer automaticamente após a meia-noite da data informada.
- O cadastro de uma câmera registra o consentimento informado para o responsável, desde que não exista opt-out ou bloqueio anterior.
- Se um responsável pedir para parar, a resposta `PARAR` bloqueia novos envios. Um opt-out ou bloqueio existente não é removido por novos cadastros; só reative o contato após uma nova autorização, em **Config. Bots → Consentimento**.
- Os bots não enviam para contatos sem consentimento, bloqueados ou fora do horário comercial. O log e a data do último aviso na câmera impedem novas tentativas por 24 horas, inclusive quando o log está indisponível; falhas recentes também evitam repetição automática.
- Os botões **Executar cobrança** e **Executar lembrete** pedem confirmação antes de iniciar. Eles podem enviar mensagens reais aos contatos autorizados.

## Integração n8n

Os JSONs em `workflows/` são fluxos antigos para a API oficial Meta e permanecem inativos. Eles usam credenciais/configuração Cloud API que não fazem parte da conexão por QR. **Não ative esses fluxos junto com os bots locais**, para evitar caminhos de envio concorrentes. Por serem fluxos n8n independentes, eles mantêm seu próprio tratamento de telefone e **não** usam a normalização central deste repositório; se forem reativados, precisam ser adaptados.

## API principal

| Método | Rota | Descrição |
|---|---|---|
| `GET` | `/api/health` | Estado do backend e quantidade de câmeras |
| `GET` | `/api/auth/me` | Usuário autenticado |
| `POST` | `/api/auth/login`, `/api/auth/logout` | Entrar e sair |
| `GET` | `/api/cameras` | Lista e filtra câmeras do tenant |
| `POST` / `PUT` / `DELETE` | `/api/cameras` | Cadastro, atualização e remoção |
| `GET` | `/api/instances` | Instâncias WhatsApp do tenant |
| `POST` | `/api/instances` | Cria uma instância |
| `POST` | `/api/instances/:id/connect`, `/disconnect`, `/qr` | Controla uma instância |
| `DELETE` | `/api/instances/:id` | Remove a instância e apaga a sessão pareada |
| `GET` | `/api/whatsapp/status` | Estado das instâncias |
| `POST` | `/api/whatsapp/connect`, `/api/whatsapp/disconnect`, `/api/whatsapp/qr` | Controla a instância ativa |
| `POST` | `/api/whatsapp/send`, `/api/whatsapp/send-options` | Envio manual |
| `GET` | `/api/whatsapp/check/:phone` | Verifica se o número existe no WhatsApp |
| `GET` | `/api/whatsapp/conversations`, `/api/whatsapp/messages/:jid` | Central de conversas |
| `GET` | `/api/jobs` | Consulta da fila persistente |
| `POST` | `/api/consent` | Registra ou remove autorização de mensagens |
| `POST` | `/api/bots/billing/run`, `/api/bots/maintenance/run` | Execução manual dos bots |

## WhatsApp persistente (`wa-server/`)

Para receber confirmação real de entrega, suba o servidor separado em `wa-server/` (VPS/Railway/Render/Fly/Docker). Ele usa Baileys 7.0.0-rc14 fixado, sessão em `SESSION_DIR`, fila com intervalo 3–8 s e webhook HMAC para o painel. O guia completo está em [`wa-server/README.md`](wa-server/README.md).

Resumo:

```bash
cp wa-server/.env.example wa-server/.env   # preencha API_KEY e WEBHOOK_SECRET
docker build -f wa-server/Dockerfile -t multiwey-wa-server .
docker run -d --restart unless-stopped --env-file wa-server/.env \
  -p 3001:3001 -v wa-session:/app/session multiwey-wa-server
```

No painel (Vercel ou servidor local), defina `WA_SERVER_URL`, `WA_API_KEY` e o **mesmo** `WEBHOOK_SECRET`. O QR é exibido no terminal e em `GET /qr` do servidor (protegido por `x-api-key`).

## Deploy na Vercel

O projeto possui um adaptador serverless em `api/index.js` e o `vercel.json` com rewrite de todas as rotas para ele. Configure o projeto da Vercel com **Framework Preset: Other**, **Build Command** e **Output Directory** vazios.

Defina estas variáveis de ambiente no projeto da Vercel (o `.env` local não é enviado ao GitHub):

- `PG_HOST`, `PG_PORT`, `PG_USER`, `PG_PASSWORD`, `PG_DATABASE` — o PostgreSQL precisa estar acessível pela rede; `127.0.0.1` não funciona na Vercel.
- Não defina `API_KEY` neste deploy: o painel não envia o cabeçalho `x-api-key` e todas as chamadas retornariam 401. Proteja o acesso com a **Password Protection** da Vercel ou restrição de IP.
- Para escolher a API oficial no deploy: `WHATSAPP_PROVIDER=meta`, `META_WA_ACCESS_TOKEN`, `META_WA_PHONE_NUMBER_ID`, `META_WA_GRAPH_VERSION` (`v27.0`), `META_WA_TEMPLATE_NAME`, `META_WA_TEMPLATE_LANGUAGE`, `META_WA_APP_SECRET`, `META_WA_VERIFY_TOKEN` e, se necessário, `META_WA_TENANT_ID`. O callback é `https://SEU_DOMINIO/api/whatsapp/meta/webhook`; assine `messages` no webhook do app Meta. Se definir `META_WA_TIMEOUT_MS`, use no máximo 7000 ms na Vercel.
- Para usar a API oficial pela Datafy: `WHATSAPP_PROVIDER=datafy`, `DATAFY_WA_ACCESS_TOKEN`, `DATAFY_WA_WEBHOOK_SECRET`, `DATAFY_WA_TEMPLATE_NAME` e `DATAFY_WA_TEMPLATE_LANGUAGE`. O callback é `https://SEU_DOMINIO/api/whatsapp/datafy/webhook`, inscrito em `messages`. O `phone_number_id` é resolvido por `/me` ou pode ser definido em `DATAFY_WA_PHONE_NUMBER_ID`. Em Production, mantenha o timeout `DATAFY_WA_TIMEOUT_MS` em até 7000 ms.
- **Recomendado:** `WA_SERVER_URL`, `WA_API_KEY` e `WEBHOOK_SECRET` para usar o servidor Baileys persistente em `wa-server/`. O módulo `lib/whatsapp.js` mantém as credenciais apenas no servidor e o painel passa a mostrar status real de entrega. Opcionalmente `WA_CONFIRM_TIMEOUT_MINUTES` (padrão 15).
- Ponte legada: `WHATSAPP_BRIDGE_URL` e opcionalmente `WHATSAPP_BRIDGE_KEY` (usada somente se `WA_SERVER_URL`/`WA_API_KEY` não estiverem definidos).

O painel publicado na Vercel **não mantém sessão WhatsApp por QR**. Com `WHATSAPP_PROVIDER=meta`, o envio usa templates aprovados e os status de entrega e respostas chegam por `POST /api/whatsapp/meta/webhook`. Com `WHATSAPP_PROVIDER=datafy`, a API Datafy aceita o envio e os status de entrega/respostas chegam por `POST /api/whatsapp/datafy/webhook`. Com `WA_SERVER_URL` configurado, o indicador da aba **Offline** consulta `/status` do servidor persistente e cada alerta exibe `na fila → enviada → entregue → lida` (ou `falhou` / `sem confirmação`) conforme os eventos assinados recebidos em `POST /api/whatsapp/webhook`. Sem webhook, o envio aceito não equivale a uma entrega. O botão **Conectar** da Central WhatsApp retorna `503` por design.

O adaptador Meta devolve `deliveryStatus: "pendente"` quando a Cloud API aceita a mensagem e retorna um id. O status só avança com o webhook de entrega; `unconfirmed` fica reservado ao timeout do receipt no Baileys local. A Vercel permite envio manual e recebimento do webhook, mas não executa os bots locais nem mantém workers em segundo plano.

**Sem Postgres remoto configurado**, o adaptador usa `db-memory.js`: o painel e as APIs respondem normalmente, mas os dados **não persistem** entre invocações/instâncias. O `/api/health` indica `"storage":"memory"`. Para persistência, configure as variáveis acima com um banco alcançável pela Vercel.

### Limitações do serverless

A Vercel executa funções sob demanda, sem processo persistente e com sistema de arquivos somente leitura. Por isso, estes recursos ficam limitados:

- Conexão/desconexão pelo WhatsApp Baileys (a integração oficial Meta ou uma ponte HTTPS pode fornecer envio serverless);
- Execução manual dos bots (depende da conexão WhatsApp);
- Processamento da fila persistente (depende de um worker com processo contínuo);
- Atualizações em tempo real via Socket.IO (WebSocket não é suportado nas funções; o painel continua funcionando via requisições HTTP, mas sem push automático).

Para usar o sistema completo — WhatsApp, bots, fila e atualizações em tempo real — execute `npm start` em um servidor com processo persistente (VPS, Railway, Render, Fly.io etc.), mantendo `HOST=127.0.0.1` atrás de um proxy reverso.

## Verificação

Execute `npm test` para rodar os testes automatizados. Eles usam apenas bancos e sessões falsos em memória, sem contas reais e sem envio de mensagens para terceiros.

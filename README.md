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

Os JSONs em `workflows/` são fluxos antigos para a API oficial Meta e permanecem inativos. Eles usam credenciais/configuração Cloud API que não fazem parte da conexão por QR. **Não ative esses fluxos junto com os bots locais**, para evitar caminhos de envio concorrentes.

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

## Deploy na Vercel

O projeto possui um adaptador serverless em `api/index.js` e o `vercel.json` com rewrite de todas as rotas para ele. Configure o projeto da Vercel com **Framework Preset: Other**, **Build Command** e **Output Directory** vazios.

Defina estas variáveis de ambiente no projeto da Vercel (o `.env` local não é enviado ao GitHub):

- `PG_HOST`, `PG_PORT`, `PG_USER`, `PG_PASSWORD`, `PG_DATABASE` — o PostgreSQL precisa estar acessível pela rede; `127.0.0.1` não funciona na Vercel.
- Não defina `API_KEY` neste deploy: o painel não envia o cabeçalho `x-api-key` e todas as chamadas retornariam 401. Proteja o acesso com a **Password Protection** da Vercel ou restrição de IP.
- Para WhatsApp pela API oficial Meta: `META_WA_ACCESS_TOKEN` e `META_WA_PHONE_NUMBER_ID`.
- Para usar uma conexão Baileys local por meio seguro: `WHATSAPP_BRIDGE_URL` e opcionalmente `WHATSAPP_BRIDGE_KEY`.

O painel publicado na Vercel **não mantém sessão WhatsApp por QR**. O botão **Conectar** retorna `503` por design e isso é comportamento esperado, não uma falha a ser corrigida no frontend. O estado `configured` confirma apenas que há credenciais de envio; não confirma conexão nem entrega. Para usar seu próprio WhatsApp e os bots Baileys, abra `http://127.0.0.1:3000` no computador onde o servidor persistente está em execução, ou hospede o backend em uma VPS/serviço persistente.

O adaptador Meta devolve `deliveryStatus: "sent"` quando a Cloud API aceita a mensagem e retorna um id. Isso não é confirmação de entrega no aparelho; `unconfirmed` fica reservado ao timeout do receipt no Baileys local.

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

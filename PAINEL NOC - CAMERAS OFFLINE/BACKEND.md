# Backend do Painel NOC

Backend HTTP local, escrito em **Node puro (sem dependências)**, para o painel de câmeras offline.

O painel continua funcionando 100% offline: `index.html` mantém os dados embutidos e pode ser aberto com duplo clique. O backend existe para:

- servir os dados por API para outras ferramentas;
- importar um novo CSV do NOC sem editar arquivos manualmente;
- regenerar `noc-organizado.csv`, `resumo-por-municipio.csv` e `index.html` automaticamente;
- permitir filtros/exportação via HTTP.

## Estrutura

```
backend/
  noc-data.js      parsing, normalização, filtros, CSV e HTML (lógica pura)
  arquivos.js      leitura/escrita, cache em memória, backup e importação
  server.js        servidor HTTP e rotas
  server.test.js   testes automatizados (node:test)
gerar-painel.js    CLI — agora reusa backend/ (mesmo comportamento de antes)
```

O CSV original (`noc-original.csv`) é a **fonte da verdade**. Os outros arquivos são derivados dele. Quando a geração parte desta pasta, os quatro artefatos (`noc-original.csv`, `noc-organizado.csv`, `resumo-por-municipio.csv` e `index.html`) são espelhados automaticamente em `../painel-noc/`, mantendo as duas cópias idênticas.

## Executar

```powershell
node backend/server.js
# ou
npm start
```

Por padrão escuta em `http://127.0.0.1:3001`. Variáveis de ambiente:

| Variável | Padrão | Descrição |
|---|---|---|
| `PAINEL_HOST` | `127.0.0.1` | Host de escuta |
| `PAINEL_PORT` | `3001` | Porta |
| `PAINEL_API_TOKEN` | vazio | Se definido, exige `x-api-key` em `/api/*` |

Exemplo com token:

```powershell
$env:PAINEL_API_TOKEN = "minha-chave"
node backend/server.js
```

## Rotas

| Método | Rota | Descrição |
|---|---|---|
| GET | `/api/health` | Saúde do serviço e resumo rápido |
| GET | `/api/painel` | Payload completo: `stats`, `data`, `resumoMunicipios` |
| GET | `/api/estatisticas` | Apenas os indicadores |
| GET | `/api/camaras` | Câmeras filtradas e paginadas |
| GET | `/api/municipios` | Resumo por município |
| GET | `/api/categorias` | Lista de categorias |
| GET | `/api/severidades` | Faixas de tempo offline (`s0`…`s4`) |
| GET | `/api/exportar.csv` | CSV filtrado para download (com BOM) |
| POST | `/api/importar` | Importa CSV novo e regenera os artefatos |
| GET | `/` , `/index.html` , `/*.csv` | Arquivos estáticos do painel |

### Filtros de `/api/camaras` e `/api/exportar.csv`

| Parâmetro | Exemplo | Observação |
|---|---|---|
| `q` | `?q=escola` | Busca em nome, ID, município, categoria, responsáveis e marcadores; ignora acentos e caixa |
| `municipio` | `?municipio=CUIABÁ` | Nome exato |
| `categoria` | `?categoria=Escolas (SEDUC)` | Nome exato |
| `status` | `?status=Offline` | `Online` ou `Offline` |
| `severidade` | `?severidade=s4` | `s0`<1h, `s1`<24h, `s2`<3d, `s3`<7d, `s4`>7d |
| `ordenar` | `?ordenar=offlineMin` | `id`, `nome`, `municipio`, `categoria`, `status`, `offlineMin`, `ultimo`, `desc24`, `sla24`, `slaTotal` |
| `direcao` | `?direcao=asc` | `asc` ou `desc` (padrão) |
| `limite` | `?limite=50` | 1 a 10000 (padrão 100) |
| `deslocamento` | `?deslocamento=100` | Paginação (padrão 0) |

### Exemplos (PowerShell)

```powershell
# Indicadores
Invoke-RestMethod http://127.0.0.1:3001/api/estatisticas

# Câmeras críticas de um município
Invoke-RestMethod "http://127.0.0.1:3001/api/camaras?municipio=CUIAB%C3%81&severidade=s4&limite=20"

# Baixar CSV filtrado
Invoke-WebRequest "http://127.0.0.1:3001/api/exportar.csv?status=Offline" -OutFile noc-offline.csv

# Validar um CSV novo sem gravar nada (dry-run)
$csv = Get-Content -Raw -Encoding UTF8 "C:\Downloads\novo-noc.csv"
Invoke-RestMethod http://127.0.0.1:3001/api/importar -Method Post -ContentType "application/json" `
  -Body (@{ csv = $csv; nomeArquivo = "novo-noc.csv"; dryRun = $true } | ConvertTo-Json -Depth 3)

# Aplicar a importação
Invoke-RestMethod http://127.0.0.1:3001/api/importar -Method Post -ContentType "application/json" `
  -Body (@{ csv = $csv; nomeArquivo = "novo-noc.csv" } | ConvertTo-Json -Depth 3)

# Também aceita o CSV cru
Invoke-RestMethod http://127.0.0.1:3001/api/importar -Method Post -ContentType "text/csv" `
  -Body (Get-Content -Raw -Encoding UTF8 "C:\Downloads\novo-noc.csv")
```

`nomeArquivo` identifica a origem apenas no `dryRun`; na importação real o `arquivoFonte` exibido no painel permanece `noc-original.csv`.

Na importação real, os arquivos anteriores são copiados para `backups/<data-hora>-<arquivo>` antes da substituição. As escritas são atômicas (temporário + `rename`) e, se qualquer etapa falhar, os backups são restaurados.

## CLI

O comando antigo continua disponível e agora compartilha as mesmas regras do backend:

```powershell
node gerar-painel.js "C:\caminho\do\novo-arquivo.csv"
```

Diferença: a importação pela API **atualiza `noc-original.csv` e cria backup**; a CLI apenas regenera os derivados a partir do arquivo informado, sem alterar o `noc-original.csv` nem o cache da API. Em ambos os casos os artefatos são espelhados em `painel-noc/`.

## Relação com o servidor principal do projeto

O servidor na raiz do repositório já expõe esta pasta estaticamente em `/painel-noc`. O backend deste documento é independente (porta 3001) e não altera `server.js`/`vercel.json`. Para expor as rotas junto ao servidor principal, basta fazer proxy de `/painel-noc/api/*` para este serviço ou chamar `criarServidor({ raiz })` diretamente.

## Testes

```powershell
npm test
```

Os testes usam diretórios temporários e não modificam os dados reais da pasta.

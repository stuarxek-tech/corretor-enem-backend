# Backend do Corretor de Redação ENEM — Deploy no Hostinger

Este servidor guarda sua chave da API da Anthropic em segredo e faz a
correção da redação por trás dos panos. O HTML do quiz (front-end)
chama este backend em vez de tentar falar direto com a IA.

## Pré-requisito

Seu plano do Hostinger precisa ser **Business web hosting** ou algum
**Cloud hosting** (Startup, Professional, Enterprise) — são os que têm
suporte a Node.js pelo hPanel. Se você estiver num plano Shared mais
básico, vai precisar fazer upgrade primeiro.

## Passo a passo

1. **Pegue sua chave da API da Anthropic**
   Entre em https://console.anthropic.com → "API Keys" → crie uma
   chave nova. Guarde ela, você vai precisar no passo 5.

2. **Acesse o hPanel do Hostinger**
   No painel do seu site, procure por "Node.js" (geralmente em
   "Avançado" ou "Website").

3. **Crie um novo app Node.js**
   - Versão do Node: 18 ou superior
   - Domínio/subdomínio: pode ser um subdomínio como
     `api.seudominio.com.br`, ou um caminho tipo
     `seudominio.com.br/api`
   - Arquivo de inicialização: `server.js`

4. **Envie os arquivos**
   Comprima esta pasta inteira (`server.js`, `package.json`) em um
   .zip e envie pelo hPanel — ou conecte via GitHub, se preferir.

5. **Configure a variável de ambiente**
   Ainda na tela do app Node.js, procure "Variáveis de ambiente" e
   adicione:
   - `ANTHROPIC_API_KEY` → cole a chave do passo 1

6. **Instale as dependências e inicie**
   O Hostinger costuma rodar `npm install` e iniciar o app
   automaticamente ao detectar o `package.json`. Se não rodar sozinho,
   tem um botão "Instalar dependências" / "Restart" no painel do app.

7. **Teste**
   Acesse `https://SEU-DOMINIO-OU-SUBDOMINIO/` no navegador — deve
   aparecer `{"status":"ok","service":"corretor-enem-backend"}`.
   Se aparecer isso, está no ar.

8. **Aponte o quiz pro backend**
   No arquivo `redacao-enem-quiz.html`, troque a constante
   `BACKEND_URL` no topo do `<script>` pelo endereço real, por
   exemplo:
   ```js
   const BACKEND_URL = 'https://api.seudominio.com.br/api/analisar-redacao';
   ```

## Segurança

- A chave da API nunca aparece no navegador do aluno — fica só no
  servidor.
- Se quiser reduzir custo por chamada, troque `claude-sonnet-5` por
  `claude-haiku-4-5-20251001` na variável `ANTHROPIC_MODEL` (mais
  rápido e mais barato, com correção um pouco menos refinada).
- Para produção real, vale adicionar um limite de requisições por
  IP (rate limiting) pra evitar abuso — posso ajudar com isso depois
  se quiser.

// ---------------------------------------------------------------
// Backend do Corretor de Redação ENEM
// Guarda a chave da API da Anthropic em segredo no servidor (nunca
// no navegador do aluno) e faz a análise da redação sob demanda.
// ---------------------------------------------------------------

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
app.use(cors()); // libera chamadas vindas do domínio onde o quiz estiver hospedado
app.use(express.json({ limit: '1mb' }));

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
// Modelo real da API (diferente do usado no protótipo dentro do Claude).
// claude-sonnet-5 é um bom equilíbrio custo/qualidade para correção de texto.
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';
// Segredo do webhook da Cakto (vem no corpo de cada notificação — compare
// antes de confiar em qualquer evento recebido).
const CAKTO_WEBHOOK_SECRET = process.env.CAKTO_WEBHOOK_SECRET || '';

// Pedidos pendentes de pagamento, em memória.
// pedidoId -> { analysis, email, paid, createdAt }
// Observação: reinicia zerado se o servidor reiniciar. Para volume alto,
// trocar por um banco de dados (o Hostinger já oferece um no painel).
const pendingAnalyses = new Map();

// IDs de pedido da Cakto já processados pelo webhook — evita conceder
// crédito em dobro se a Cakto reenviar a mesma entrega (acontece quando
// nossa resposta demora ou a rede falha no meio do caminho).
const webhookProcessados = new Map(); // data.id -> timestamp
setInterval(() => {
  const limite = Date.now() - 48 * 60 * 60 * 1000;
  for (const [id, ts] of webhookProcessados) {
    if (ts < limite) webhookProcessados.delete(id);
  }
}, 60 * 60 * 1000);

// Contas com créditos comprados (qualquer um dos pacotes) — em memória.
// email -> { creditos }
const contas = new Map();

// Reconhece pacotes de créditos automaticamente pelo nome do produto na
// Cakto: se o nome contém "crédito(s)", o número encontrado no nome vira
// a quantidade de créditos concedida (ex: "8 Créditos" concede 8, "1
// Crédito Avulso" concede 1). Não precisa configurar nada por pacote —
// funciona pra qualquer quantidade que você crie no futuro.
function normalizar(s){
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// Limpeza: remove pedidos com mais de 48h (evita crescer pra sempre)
setInterval(() => {
  const limite = Date.now() - 48 * 60 * 60 * 1000;
  for (const [id, p] of pendingAnalyses) {
    if (p.createdAt < limite) pendingAnalyses.delete(id);
  }
}, 60 * 60 * 1000);

const COMP_TITLES = [
  'Domínio da norma culta',
  'Compreensão do tema',
  'Argumentação',
  'Coesão textual',
  'Proposta de intervenção'
];

// HTML embutido diretamente no código (não depende de encontrar um
// arquivo separado no disco depois do build/deploy).
const QUIZ_HTML = "<!DOCTYPE html>\n<html lang=\"pt-BR\">\n<head>\n<meta charset=\"UTF-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">\n<title>Quanto vale a sua redação?</title>\n<link rel=\"icon\" type=\"image/png\" href=\"data:image/png;base64,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\">\n<link rel=\"preconnect\" href=\"https://fonts.googleapis.com\">\n<link rel=\"preconnect\" href=\"https://fonts.gstatic.com\" crossorigin>\n<link rel=\"preconnect\" href=\"https://api.anthropic.com\">\n<link rel=\"dns-prefetch\" href=\"https://api.anthropic.com\">\n<link rel=\"stylesheet\" href=\"https://fonts.googleapis.com/css2?family=Kalam:wght@400;700&family=Source+Serif+4:opsz,wght@8..60,400;8..60,600;8..60,700&family=Inter:wght@400;500;600;700&display=swap\">\n<style>\n  :root{\n    --paper:#F7F3E8;\n    --paper-line: rgba(94,122,156,.16);\n    --paper-margin: rgba(179,38,30,.28);\n    --ink:#202B3B;\n    --ink-soft:#5B6B80;\n    --red:#B3261E;\n    --red-dark:#8C1D17;\n    --red-soft:#F5DBD8;\n    --good:#2F6F5E;\n    --good-soft:#DCEDE7;\n    --surface:#FFFFFF;\n    --shadow: rgba(32,43,59,.12);\n    --font-display:'Source Serif 4', Georgia, serif;\n    --font-hand:'Kalam', cursive;\n    --font-body:'Inter', system-ui, sans-serif;\n  }\n  *{box-sizing:border-box;}\n  html,body{margin:0;padding:0;}\n  body{\n    background:\n      linear-gradient(90deg, transparent 0 46px, var(--paper-margin) 46px 47px, transparent 47px 100%),\n      repeating-linear-gradient(var(--paper) 0 31px, var(--paper-line) 31px 32px),\n      var(--paper);\n    font-family: var(--font-body);\n    color: var(--ink);\n    min-height:100vh;\n    -webkit-font-smoothing:antialiased;\n  }\n  #app{max-width:640px;margin:0 auto;padding:36px 22px 70px;min-height:100vh;}\n  .eyebrow{\n    font-family:var(--font-hand);\n    color:var(--red);\n    font-size:19px;\n    transform:rotate(-2deg);\n    display:inline-block;\n    margin-bottom:6px;\n  }\n  h1{font-family:var(--font-display);font-weight:700;font-size:34px;line-height:1.15;margin:0 0 14px;color:var(--ink);}\n  h2{font-family:var(--font-display);font-weight:600;font-size:24px;margin:0 0 10px;color:var(--ink);}\n  p.lead{color:var(--ink-soft);font-size:16px;line-height:1.55;margin:0 0 26px;}\n  .card{\n    background:var(--surface);\n    border-radius:14px;\n    box-shadow:0 10px 30px var(--shadow);\n    padding:24px;\n  }\n  .btn{\n    font-family:var(--font-body);\n    font-weight:600;\n    font-size:15.5px;\n    border:none;\n    border-radius:10px;\n    padding:15px 22px;\n    cursor:pointer;\n    transition:transform .15s ease, box-shadow .15s ease;\n    width:100%;\n  }\n  .btn:active{transform:scale(.98);}\n  .btn-primary{background:var(--red);color:#fff;box-shadow:0 8px 20px rgba(179,38,30,.28);}\n  .btn-primary:hover{background:var(--red-dark);}\n  .btn-ghost{background:transparent;color:var(--ink-soft);border:1.5px solid #DCD5C4;}\n  .progress-wrap{display:flex;gap:6px;margin-bottom:28px;}\n  .progress-seg{height:5px;flex:1;background:#E5DFCF;border-radius:3px;overflow:hidden;}\n  .progress-seg > div{height:100%;background:var(--red);width:0%;transition:width .4s ease;}\n  .qnum{font-family:var(--font-hand);color:var(--ink-soft);font-size:16px;margin-bottom:6px;}\n  .option{\n    display:block;width:100%;text-align:left;\n    background:var(--surface);border:1.5px solid #E5DFCF;border-radius:12px;\n    padding:16px 18px;margin-bottom:10px;font-size:15.5px;color:var(--ink);\n    cursor:pointer;transition:border-color .15s ease, background .15s ease;\n    font-family:var(--font-body);\n  }\n  .option:hover{border-color:var(--red);background:#FFF9F8;}\n  .stamp-wrap{display:flex;justify-content:center;margin:6px 0 24px;}\n  .stamp{\n    width:150px;height:150px;border-radius:50%;\n    border:4px solid var(--red);\n    display:flex;flex-direction:column;align-items:center;justify-content:center;\n    transform:rotate(-8deg);\n    font-family:var(--font-display);\n    color:var(--red);\n    box-shadow:0 0 0 3px rgba(179,38,30,.08);\n  }\n  .stamp .n{font-size:40px;font-weight:700;line-height:1;}\n  .stamp .d{font-family:var(--font-hand);font-size:14px;margin-top:2px;}\n  .checklist{list-style:none;padding:0;margin:22px 0;}\n  .checklist li{\n    display:flex;align-items:center;gap:10px;padding:10px 0;\n    color:var(--ink-soft);font-size:15px;\n    opacity:0;animation:fadeIn .5s ease forwards;\n  }\n  .checklist li:nth-child(1){animation-delay:.2s;}\n  .checklist li:nth-child(2){animation-delay:1s;}\n  .checklist li:nth-child(3){animation-delay:1.8s;}\n  .checklist li .dot{width:20px;height:20px;border-radius:50%;border:2px solid var(--good);flex:none;position:relative;}\n  .checklist li .dot::after{content:'';position:absolute;left:5px;top:2px;width:5px;height:9px;border:solid var(--good);border-width:0 2px 2px 0;transform:rotate(45deg);}\n  @keyframes fadeIn{to{opacity:1;}}\n  textarea, input[type=text]{\n    width:100%;font-family:var(--font-body);font-size:15.5px;color:var(--ink);\n    border:1.5px solid #E5DFCF;border-radius:10px;padding:14px;\n    background:#FFFEFB;resize:vertical;\n  }\n  textarea{min-height:260px;line-height:1.7;}\n  label.field-label{display:block;font-size:13px;font-weight:600;color:var(--ink-soft);text-transform:uppercase;letter-spacing:.04em;margin:18px 0 6px;}\n  .word-count{font-size:13px;color:var(--ink-soft);margin-top:6px;text-align:right;}\n  .word-count.ok{color:var(--good);}\n  .pen-loader{display:flex;flex-direction:column;align-items:center;padding:60px 20px;}\n  .pen-emoji{font-size:44px;animation:wiggle 1s ease-in-out infinite;}\n  @keyframes wiggle{0%,100%{transform:rotate(-8deg);}50%{transform:rotate(8deg);}}\n  .loading-msg{font-family:var(--font-hand);font-size:19px;color:var(--ink-soft);margin-top:18px;text-align:center;min-height:28px;}\n  .blur{filter:blur(6px);user-select:none;pointer-events:none;}\n  .lock-badge{\n    display:inline-flex;align-items:center;gap:6px;background:var(--ink);color:#fff;\n    font-size:12px;font-weight:600;padding:5px 10px;border-radius:20px;margin-bottom:10px;\n  }\n  .paywall-cta{\n    margin-top:22px;padding:20px;border-radius:14px;\n    background:linear-gradient(180deg,#fff, #FFF6F5);\n    border:1.5px dashed var(--red);\n    text-align:center;\n  }\n  .pricing-card{\n    position:relative;background:var(--surface);border:1.5px solid #E5DFCF;border-radius:12px;\n    padding:16px 18px;margin-top:16px;cursor:pointer;text-align:left;\n    transition:border-color .15s ease, transform .15s ease;\n  }\n  .pricing-card:hover{border-color:var(--red);transform:translateY(-1px);}\n  .pricing-card:active{transform:scale(.99);}\n  .pricing-row{display:flex;justify-content:space-between;align-items:center;}\n  .pricing-name{font-weight:700;font-size:15.5px;color:var(--ink);}\n  .pricing-detail{font-size:12.5px;color:var(--ink-soft);margin-top:2px;}\n  .pricing-price{font-family:var(--font-display);font-weight:700;font-size:20px;color:var(--red);white-space:nowrap;}\n  .analise-preview{\n    position:relative;margin-top:20px;padding:14px 16px 34px;\n    background:#FBFAF5;border-radius:12px;border:1px solid #E5DFCF;\n    max-height:76px;overflow:hidden;\n  }\n  .analise-label{font-weight:700;color:var(--red);font-size:11.5px;text-transform:uppercase;letter-spacing:.04em;margin-bottom:6px;}\n  .analise-text{font-size:13.5px;line-height:1.6;color:var(--ink);}\n  .analise-preview::after{\n    content:'';position:absolute;left:0;right:0;bottom:0;height:52px;\n    background:linear-gradient(180deg, rgba(251,250,245,0) 0%, #FBFAF5 85%);\n    pointer-events:none;\n  }\n  .comp-row{margin-bottom:18px;}\n  .comp-head{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px;}\n  .comp-title{font-weight:600;font-size:14.5px;}\n  .comp-score{font-family:var(--font-display);font-weight:700;color:var(--red);}\n  .comp-bar{height:8px;background:#EDE7D8;border-radius:5px;overflow:hidden;}\n  .comp-bar > div{height:100%;background:var(--red);border-radius:5px;}\n  .comp-comment{font-size:13.5px;color:var(--ink-soft);margin-top:5px;line-height:1.4;}\n  .cols{display:flex;gap:16px;margin-top:22px;}\n  .col{flex:1;background:#FBFAF5;border-radius:12px;padding:14px 16px;}\n  .col h3{font-size:13px;text-transform:uppercase;letter-spacing:.03em;margin:0 0 10px;color:var(--ink-soft);}\n  .col.good h3{color:var(--good);}\n  .col.bad h3{color:var(--red);}\n  .col ul{margin:0;padding-left:18px;font-size:13.5px;line-height:1.6;}\n  .essay-box{\n    margin-top:24px;background:#FFFEFB;border:1.5px solid #E5DFCF;border-radius:12px;\n    padding:20px;font-family:var(--font-body);font-size:15px;line-height:1.85;white-space:pre-wrap;\n  }\n  mark.err{background:none;color:var(--red);text-decoration:underline wavy var(--red);text-underline-offset:3px;font-weight:600;}\n  mark.ok{background:var(--good-soft);color:var(--good);border-radius:3px;padding:0 2px;font-weight:600;}\n  sup{font-family:var(--font-hand);color:var(--red);font-size:13px;}\n  .notes{list-style:none;padding:0;margin:14px 0 0;}\n  .notes li{display:flex;gap:8px;font-size:13.5px;color:var(--ink-soft);padding:6px 0;border-top:1px dashed #E5DFCF;}\n  .notes li b{color:var(--red);font-family:var(--font-hand);font-size:15px;}\n  .top-nav{display:flex;justify-content:space-between;align-items:center;margin-bottom:18px;}\n  .top-nav .brand{font-family:var(--font-hand);font-size:18px;color:var(--red);}\n  .footer-note{font-size:12px;color:var(--ink-soft);text-align:center;margin-top:26px;opacity:.7;}\n  .error-box{background:#FFF3F2;border:1.5px solid var(--red-soft);color:var(--red-dark);padding:14px 16px;border-radius:10px;font-size:14px;margin-top:14px;}\n</style>\n</head>\n<body>\n<div id=\"app\"></div>\n\n<script>\n// ---------------------------------------------------------------\n// PROTÓTIPO — Corretor de Redação ENEM (quiz + análise por IA)\n// Paywall está em modo DEMONSTRAÇÃO: o botão libera o resultado\n// direto. Para produção, troque unlockResult() por um redirect\n// para o checkout real (ex: Cakto) e só chame renderResult()\n// depois de confirmar o pagamento (via retorno de URL / webhook).\n// ---------------------------------------------------------------\n\nconst QUESTIONS = [\n  {\n    q: \"Quantas vezes você já treinou uma redação nota 1000?\",\n    options: [\"Nunca treinei\", \"Já tentei, mas travo no meio\", \"Escrevo bem, quero afinar detalhes\", \"Não sei nem por onde começar\"]\n  },\n  {\n    q: \"Qual competência mais te assusta?\",\n    options: [\"Competência 1 — Gramática e norma culta\", \"Competência 2 — Repertório sociocultural\", \"Competência 3 — Argumentação\", \"Competência 4 — Coesão textual\", \"Competência 5 — Proposta de intervenção\"]\n  },\n  {\n    q: \"Qual sua meta de nota na redação?\",\n    options: [\"Acima de 900\", \"Entre 800 e 900\", \"Entre 600 e 800\", \"Só passar de 600\"]\n  },\n  {\n    q: \"Quando é sua prova?\",\n    options: [\"Nas próximas semanas\", \"Nos próximos meses\", \"Ano que vem\", \"Ainda não sei\"]\n  },\n  {\n    q: \"O que você mais precisa agora?\",\n    options: [\"Saber minha nota real\", \"Entender meus erros específicos\", \"Um plano pra evoluir\", \"Confiança pro dia da prova\"]\n  }\n];\n\nconst LOADING_MESSAGES = [\n  \"Lendo sua redação com calma...\",\n  \"Avaliando domínio da norma culta...\",\n  \"Conferindo o repertório sociocultural...\",\n  \"Analisando a força dos seus argumentos...\",\n  \"Checando a coesão entre parágrafos...\",\n  \"Avaliando sua proposta de intervenção...\",\n  \"Fechando a correção...\"\n];\n\n// Mesmos 3 checkouts de sempre — só o nome/preço deles muda na Cakto.\n// IMPORTANTE: o produto da chave 'vitalicio' precisa ter \"vitalício\" no\n// nome/oferta na Cakto (é assim que o backend reconhece acesso ilimitado,\n// em vez de tentar contar um número de créditos).\nconst CHECKOUT_URLS = {\n  '1': 'https://pay.cakto.com.br/yasicjg_1153271',\n  '10': 'https://pay.cakto.com.br/38qdimv_1153316',\n  'vitalicio': 'https://pay.cakto.com.br/iwe24m7_1153334'\n};\n\nlet state = {\n  screen: 'welcome',\n  quizIndex: 0,\n  answers: [],\n  tema: '',\n  essay: '',\n  pedidoId: null,\n  teaser: null,\n  analysis: null,\n  error: '',\n  errorDetail: ''\n};\n\nfunction setState(patch){ state = Object.assign({}, state, patch); render(); }\nfunction el(id){ return document.getElementById(id); }\n\nfunction escapeHtml(str){\n  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\"/g,'&quot;').replace(/'/g,'&#39;');\n}\n\n// ---------- Navegação ----------\nwindow.startQuiz = function(){ setState({screen:'quiz', quizIndex:0, answers:[]}); };\n\nwindow.selectAnswer = function(optIndex){\n  const answers = state.answers.concat([QUESTIONS[state.quizIndex].options[optIndex]]);\n  if(state.quizIndex + 1 < QUESTIONS.length){\n    setState({answers, quizIndex: state.quizIndex + 1});\n  } else {\n    setState({answers, screen:'transition'});\n    setTimeout(()=> setState({screen:'essay'}), 2600);\n  }\n};\n\nwindow.goSubmitEssay = function(){\n  const tema = el('temaInput').value.trim();\n  const essay = el('essayInput').value.trim();\n  const wc = essay ? essay.split(/\\s+/).filter(Boolean).length : 0;\n  if(wc < 50){\n    setState({tema, essay, error:'Sua redação precisa ter pelo menos 50 palavras para uma análise completa (atual: ' + wc + ').'});\n    return;\n  }\n  setState({tema, essay, error:'', screen:'analyzing'});\n  analyzeEssay(tema, essay);\n};\n\n// Confere com o servidor se o aluno já tem créditos (libera na hora) —\n// senão, manda pro checkout do pacote escolhido na Cakto.\nwindow.irParaCheckout = async function(pacote){\n  const emailInput = el('emailPaywall');\n  const email = emailInput ? emailInput.value.trim() : '';\n  if(!email || !/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email)){\n    setState({error:'Digite um e-mail válido — é ele que vamos usar pra confirmar seu pagamento.'});\n    return;\n  }\n  try{\n    const resp = await fetch('/api/desbloquear', {\n      method: 'POST',\n      headers: {'Content-Type':'application/json'},\n      body: JSON.stringify({ pedidoId: state.pedidoId, email })\n    });\n    const data = await resp.json().catch(()=>({}));\n    if(!resp.ok){\n      setState({error: data.error || 'Não consegui verificar seu e-mail. Tente de novo.'});\n      return;\n    }\n    if(data.status === 'liberado'){\n      setState({ analysis: data.analysis, screen:'result' });\n      return;\n    }\n    localStorage.setItem('corretorEnemPedidoId', state.pedidoId);\n    localStorage.setItem('corretorEnemEmail', email);\n    window.location.href = CHECKOUT_URLS[pacote] || CHECKOUT_URLS[1];\n  } catch(err){\n    setState({error:'Não consegui conectar pra verificar seu e-mail. Tente de novo.'});\n  }\n};\n\nwindow.verificarPagamento = function(){\n  setState({screen:'aguardando-pagamento', error:''});\n  pollStatusPedido(state.pedidoId, 0);\n};\n\nwindow.restart = function(){\n  localStorage.removeItem('corretorEnemPedidoId');\n  localStorage.removeItem('corretorEnemEmail');\n  setState({screen:'welcome', quizIndex:0, answers:[], tema:'', essay:'', pedidoId:null, teaser:null, analysis:null, error:'', errorDetail:''});\n};\n\n// ---------- Chamada à IA ----------\n// Tenta até 3x automaticamente (com pequeno intervalo) antes de mostrar\n// qualquer erro pro aluno. A tela permanece em \"analyzing\" durante as\n// tentativas — quem está do outro lado só vê o loading rodando.\nconst MAX_ATTEMPTS = 3;\n\n// Como o quiz e o backend agora estão no mesmo domínio, um caminho\n// relativo funciona direto — não precisa editar nada aqui.\nconst BACKEND_URL = '/api/analisar-redacao';\n\nasync function analyzeEssay(tema, essay, attempt){\n  attempt = attempt || 1;\n\n  try{\n    const response = await fetch(BACKEND_URL, {\n      method: \"POST\",\n      headers: { \"Content-Type\": \"application/json\" },\n      body: JSON.stringify({ tema, essay })\n    });\n    const data = await response.json();\n    if(!response.ok || data.error){\n      throw new Error((data && data.error) || ('Resposta HTTP ' + response.status));\n    }\n    if(!data.pedidoId || !data.teaser || !Array.isArray(data.teaser.competencias)){\n      throw new Error('Resposta do backend veio incompleta');\n    }\n    setState({ pedidoId: data.pedidoId, teaser: data.teaser, screen:'paywall' });\n  } catch(err){\n    console.error('Erro ao analisar redação (tentativa ' + attempt + ' de ' + MAX_ATTEMPTS + '):', err);\n    if(attempt < MAX_ATTEMPTS){\n      setTimeout(() => analyzeEssay(tema, essay, attempt + 1), 900);\n    } else {\n      const detail = (err && err.name ? err.name + ': ' : '') + ((err && err.message) || String(err));\n      setState({ screen:'error', error:'Não consegui analisar sua redação agora.', errorDetail: detail });\n    }\n  }\n}\n\n// Consulta se o pagamento já foi confirmado pelo webhook da Cakto.\n// Tenta por até ~3 minutos (o webhook costuma chegar em segundos, mas\n// dá uma folga generosa pra Pix/boleto ou lentidão pontual).\nasync function pollStatusPedido(pedidoId, tentativa){\n  tentativa = tentativa || 0;\n  try{\n    const resp = await fetch('/api/status-pedido/' + encodeURIComponent(pedidoId));\n    const data = await resp.json();\n    if(resp.ok && data.paid && data.analysis){\n      localStorage.removeItem('corretorEnemPedidoId');\n      localStorage.removeItem('corretorEnemEmail');\n      setState({ analysis: data.analysis, screen:'result' });\n      return;\n    }\n  } catch(err){\n    console.error('Erro ao consultar status do pedido:', err);\n  }\n  if(tentativa < 60){\n    setTimeout(() => pollStatusPedido(pedidoId, tentativa + 1), 3000);\n  } else {\n    setState({ error:'Ainda não identificamos seu pagamento. Se você já pagou, aguarde mais um instante e tente de novo — ou fale com o suporte.' });\n  }\n}\n\n// ---------- Render ----------\nfunction render(){\n  const app = el('app') || document.getElementById('app');\n  switch(state.screen){\n    case 'welcome': app.innerHTML = screenWelcome(); break;\n    case 'quiz': app.innerHTML = screenQuiz(); break;\n    case 'transition': app.innerHTML = screenTransition(); break;\n    case 'essay': app.innerHTML = screenEssay(); break;\n    case 'analyzing': app.innerHTML = screenAnalyzing(); startLoadingRotation(); break;\n    case 'paywall': app.innerHTML = screenPaywall(); break;\n    case 'aguardando-pagamento': app.innerHTML = screenAguardandoPagamento(); break;\n    case 'result': app.innerHTML = screenResult(); break;\n    case 'error': app.innerHTML = screenError(); break;\n  }\n}\n\nfunction topNav(brand){\n  return '<div class=\"top-nav\"><span class=\"brand\">' + brand + '</span></div>';\n}\n\nfunction screenWelcome(){\n  return topNav('✎ Corretor ENEM') +\n  '<span class=\"eyebrow\">correção nas 5 competências</span>' +\n  '<h1>Quanto vale a sua redação, de verdade?</h1>' +\n  '<p class=\"lead\">Responda 5 perguntas rápidas, cole sua redação e receba uma correção detalhada — competência por competência, do jeito que cai na prova.</p>' +\n  '<div class=\"card\">' +\n    '<button class=\"btn btn-primary\" onclick=\"startQuiz()\">Começar avaliação →</button>' +\n  '</div>' +\n  '<p class=\"footer-note\">5 perguntas rápidas + sua redação = diagnóstico completo</p>';\n}\n\nfunction screenQuiz(){\n  const total = QUESTIONS.length;\n  const q = QUESTIONS[state.quizIndex];\n  let segs = '';\n  for(let i=0;i<total;i++){\n    const fill = i < state.quizIndex ? '100%' : (i === state.quizIndex ? '60%' : '0%');\n    segs += '<div class=\"progress-seg\"><div style=\"width:' + fill + '\"></div></div>';\n  }\n  let opts = '';\n  q.options.forEach((o,i) => {\n    opts += '<button class=\"option\" onclick=\"selectAnswer(' + i + ')\">' + escapeHtml(o) + '</button>';\n  });\n  return topNav('✎ Corretor ENEM') +\n  '<div class=\"progress-wrap\">' + segs + '</div>' +\n  '<div class=\"qnum\">Pergunta ' + (state.quizIndex+1) + ' de ' + total + '</div>' +\n  '<h2>' + escapeHtml(q.q) + '</h2>' +\n  '<div style=\"margin-top:18px;\">' + opts + '</div>';\n}\n\nfunction screenTransition(){\n  const foco = state.answers[1] || 'seus principais pontos fracos';\n  const meta = state.answers[2] || 'uma nota melhor';\n  return '<div class=\"pen-loader\">' +\n    '<div class=\"stamp-wrap\"><div class=\"stamp\"><div class=\"n\">✎</div><div class=\"d\">analisando</div></div></div>' +\n    '<h2 style=\"text-align:center;\">Montando seu diagnóstico...</h2>' +\n    '<ul class=\"checklist\" style=\"max-width:360px;\">' +\n      '<li><span class=\"dot\"></span> Perfil identificado: foco em ' + escapeHtml(foco) + '</li>' +\n      '<li><span class=\"dot\"></span> Meta traçada: ' + escapeHtml(meta) + '</li>' +\n      '<li><span class=\"dot\"></span> Preparando tela para colar sua redação</li>' +\n    '</ul>' +\n  '</div>';\n}\n\nfunction screenEssay(){\n  const errBox = state.error ? '<div class=\"error-box\">' + escapeHtml(state.error) + '</div>' : '';\n  return topNav('✎ Corretor ENEM') +\n  '<h2>Cole sua redação abaixo</h2>' +\n  '<p class=\"lead\">Quanto mais fiel ao texto final, mais precisa é a correção.</p>' +\n  '<label class=\"field-label\">Tema da redação (opcional)</label>' +\n  '<input type=\"text\" id=\"temaInput\" placeholder=\"Ex: Desafios para a valorização de comunidades tradicionais no Brasil\" value=\"' + escapeHtml(state.tema) + '\">' +\n  '<label class=\"field-label\">Sua redação</label>' +\n  '<textarea id=\"essayInput\" placeholder=\"Cole aqui o texto completo da sua redação...\">' + escapeHtml(state.essay) + '</textarea>' +\n  errBox +\n  '<button class=\"btn btn-primary\" style=\"margin-top:18px;\" onclick=\"goSubmitEssay()\">Analisar minha redação</button>';\n}\n\nfunction screenAnalyzing(){\n  return '<div class=\"pen-loader\">' +\n    '<div class=\"pen-emoji\">✎</div>' +\n    '<div class=\"loading-msg\" id=\"loadingMsg\">' + LOADING_MESSAGES[0] + '</div>' +\n  '</div>';\n}\n\nlet loadingInterval = null;\nfunction startLoadingRotation(){\n  if(loadingInterval) clearInterval(loadingInterval);\n  let i = 0;\n  loadingInterval = setInterval(() => {\n    i = (i+1) % LOADING_MESSAGES.length;\n    const node = el('loadingMsg');\n    if(node) node.textContent = LOADING_MESSAGES[i]; else clearInterval(loadingInterval);\n  }, 1400);\n}\n\nfunction screenPaywall(){\n  const t = state.teaser;\n  const fortesPreview = (t.pontosFortes && t.pontosFortes[0]) || 'seus pontos fortes identificados na correção';\n  const errBox = state.error ? '<div class=\"error-box\">' + escapeHtml(state.error) + '</div>' : '';\n  return topNav('✎ Corretor ENEM') +\n  '<span class=\"lock-badge\">🔒 correção pronta</span>' +\n  '<h2>Sua redação já foi corrigida!</h2>' +\n  '<p class=\"lead\">Veja uma prévia — o restante da correção está bloqueado até a confirmação do pagamento.</p>' +\n  '<div class=\"card\">' +\n    t.competencias.slice(0, 2).map(buildCompRow).join('') +\n    t.competencias.slice(2).map(buildLockedCompRow).join('') +\n    '<div class=\"cols\">' +\n      '<div class=\"col good\"><h3>Pontos fortes</h3><ul><li>' + escapeHtml(fortesPreview) + '</li></ul></div>' +\n    '</div>' +\n    '<div class=\"analise-preview\">' +\n      '<div class=\"analise-label\">Análise crítica — o que mudar</div>' +\n      '<div class=\"analise-text\">' + escapeHtml(t.analisePreview || '') + '</div>' +\n    '</div>' +\n  '</div>' +\n  '<div class=\"paywall-cta\">' +\n    '<div style=\"font-family:var(--font-hand);font-size:22px;color:var(--red);margin-bottom:4px;\">nota final bloqueada</div>' +\n    '<p style=\"font-size:13.5px;color:var(--ink-soft);margin:0 0 14px;\">Escolha um pacote pra desbloquear essa correção — os créditos extras ficam guardados na sua conta pras próximas redações.</p>' +\n    '<label class=\"field-label\" style=\"text-align:left;\">Seu e-mail</label>' +\n    '<input type=\"text\" id=\"emailPaywall\" placeholder=\"seuemail@exemplo.com\" style=\"margin-bottom:16px;\">' +\n    errBox +\n    pricingCard('1', 'Avulso', 'R$ 7,90', '1 correção', null) +\n    pricingCard('10', 'Pacote Ideal', 'R$ 29,90', '10 correções · R$ 2,99 cada', null) +\n    pricingCard('vitalicio', 'Acesso Vitalício', 'R$ 59,90', 'correções ilimitadas até você passar', 'MELHOR ESCOLHA') +\n  '</div>';\n}\n\nfunction pricingCard(chave, nome, preco, detalhe, badge){\n  const destaque = badge ? ' style=\"border-color:var(--red);border-width:2px;position:relative;\"' : '';\n  const badgeHtml = badge ? '<div style=\"position:absolute;top:-11px;left:50%;transform:translateX(-50%);background:var(--red);color:#fff;font-size:11px;font-weight:700;padding:3px 12px;border-radius:10px;letter-spacing:.03em;\">' + badge + '</div>' : '';\n  return '<div class=\"pricing-card\"' + destaque + ' onclick=\"irParaCheckout(\\'' + chave + '\\')\">' +\n    badgeHtml +\n    '<div class=\"pricing-row\">' +\n      '<div>' +\n        '<div class=\"pricing-name\">' + nome + '</div>' +\n        '<div class=\"pricing-detail\">' + detalhe + '</div>' +\n      '</div>' +\n      '<div class=\"pricing-price\">' + preco + '</div>' +\n    '</div>' +\n  '</div>';\n}\n\nconst FAKE_WIDTHS = {2: 72, 3: 55, 4: 84, 5: 63};\nconst FAKE_COMMENTS = {\n  2: 'O texto demonstra compreensão do tema e articula repertório de forma consistente ao longo do desenvolvimento.',\n  3: 'A argumentação apresenta organização clara, com ideias conectadas entre os parágrafos de forma coerente.',\n  4: 'Os mecanismos de coesão utilizados garantem fluidez entre as ideias apresentadas no texto.',\n  5: 'A proposta de intervenção contempla os elementos esperados pela banca avaliadora do exame.'\n};\nfunction buildLockedCompRow(c){\n  const largura = FAKE_WIDTHS[c.numero] || 65;\n  const comentario = FAKE_COMMENTS[c.numero] || 'Avaliação detalhada disponível após o desbloqueio.';\n  return '<div class=\"comp-row\">' +\n    '<div class=\"comp-head\"><span class=\"comp-title\">' + escapeHtml(c.titulo) + '</span><span class=\"comp-score\">🔒</span></div>' +\n    '<div class=\"comp-bar blur\"><div style=\"width:' + largura + '%\"></div></div>' +\n    '<div class=\"comp-comment blur\">' + comentario + '</div>' +\n  '</div>';\n}\n\nfunction screenAguardandoPagamento(){\n  const errBox = state.error ? '<div class=\"error-box\">' + escapeHtml(state.error) + '</div>' : '';\n  return topNav('✎ Corretor ENEM') +\n  '<div class=\"pen-loader\">' +\n    '<div class=\"pen-emoji\">⏳</div>' +\n    '<h2 style=\"text-align:center;\">Confirmando seu pagamento...</h2>' +\n    '<p class=\"loading-msg\">Isso costuma levar só alguns segundos</p>' +\n    errBox +\n    '<button class=\"btn btn-ghost\" style=\"margin-top:22px;\" onclick=\"verificarPagamento()\">Verificar novamente</button>' +\n    '<button class=\"btn btn-ghost\" style=\"margin-top:10px;background:transparent;border:none;color:var(--ink-soft);text-decoration:underline;font-size:13px;\" onclick=\"restart()\">Cancelar e recomeçar</button>' +\n  '</div>';\n}\n\nfunction buildCompRow(c){\n  return '<div class=\"comp-row\">' +\n    '<div class=\"comp-head\"><span class=\"comp-title\">' + escapeHtml(c.titulo) + '</span><span class=\"comp-score\">' + c.nota + '/200</span></div>' +\n    '<div class=\"comp-bar\"><div style=\"width:' + (c.nota/200*100) + '%\"></div></div>' +\n    '<div class=\"comp-comment\">' + escapeHtml(c.comentario) + '</div>' +\n  '</div>';\n}\n\nfunction screenResult(){\n  const a = state.analysis;\n  let compsHtml = '';\n  a.competencias.forEach(c => { compsHtml += buildCompRow(c); });\n\n  let fortesHtml = '', fracosHtml = '';\n  (a.pontosFortes||[]).forEach(p => fortesHtml += '<li>' + escapeHtml(p) + '</li>');\n  (a.pontosFracos||[]).forEach(p => fracosHtml += '<li>' + escapeHtml(p) + '</li>');\n\n  // Anotações sobre o texto original\n  let essayEscaped = escapeHtml(state.essay);\n  let notesHtml = '';\n  (a.anotacoes||[]).forEach((n, idx) => {\n    const trechoEsc = escapeHtml(n.trecho || '');\n    if(trechoEsc && essayEscaped.indexOf(trechoEsc) !== -1){\n      const cls = n.tipo === 'elogio' ? 'ok' : 'err';\n      const marked = '<mark class=\"' + cls + '\">' + trechoEsc + '<sup>' + (idx+1) + '</sup></mark>';\n      essayEscaped = essayEscaped.replace(trechoEsc, marked);\n    }\n    notesHtml += '<li><b>' + (idx+1) + '.</b> ' + escapeHtml(n.comentario || '') + '</li>';\n  });\n\n  return topNav('✎ Corretor ENEM') +\n  '<div class=\"stamp-wrap\"><div class=\"stamp\"><div class=\"n\">' + a.notaTotal + '</div><div class=\"d\">/ 1000</div></div></div>' +\n  '<h2 style=\"text-align:center;\">Correção completa</h2>' +\n  '<div class=\"card\">' +\n    compsHtml +\n    '<div class=\"cols\">' +\n      '<div class=\"col good\"><h3>Pontos fortes</h3><ul>' + fortesHtml + '</ul></div>' +\n      '<div class=\"col bad\"><h3>Pontos a melhorar</h3><ul>' + fracosHtml + '</ul></div>' +\n    '</div>' +\n  '</div>' +\n  '<h2 style=\"margin-top:28px;\">Sua redação anotada</h2>' +\n  '<div class=\"essay-box\">' + essayEscaped + '</div>' +\n  '<ul class=\"notes\">' + notesHtml + '</ul>' +\n  '<button class=\"btn btn-ghost\" style=\"margin-top:26px;\" onclick=\"restart()\">Analisar outra redação</button>';\n}\n\nfunction screenError(){\n  const detail = state.errorDetail ? '<details style=\"margin-top:10px;\"><summary style=\"cursor:pointer;font-size:12.5px;color:var(--ink-soft);\">Detalhes técnicos</summary><pre style=\"white-space:pre-wrap;font-size:12px;background:#F3EFE3;border-radius:8px;padding:10px;margin-top:6px;color:var(--ink-soft);font-family:monospace;\">' + escapeHtml(state.errorDetail) + '</pre></details>' : '';\n  return topNav('✎ Corretor ENEM') +\n  '<h2>Algo não saiu como esperado</h2>' +\n  '<div class=\"error-box\">' + escapeHtml(state.error) + detail + '</div>' +\n  '<button class=\"btn btn-primary\" style=\"margin-top:18px;\" onclick=\"setState({screen:\\'essay\\', errorDetail:\\'\\'})\">Tentar novamente</button>';\n}\n\n// Se o aluno já tinha um pedido em aberto (voltando do checkout, ou\n// recarregando a página antes do pagamento confirmar), retoma direto\n// na tela de verificação em vez de começar o quiz do zero.\nconst pedidoSalvo = localStorage.getItem('corretorEnemPedidoId');\nif(pedidoSalvo){\n  state = Object.assign({}, state, { pedidoId: pedidoSalvo, screen: 'aguardando-pagamento' });\n  pollStatusPedido(pedidoSalvo, 0);\n}\n\nrender();\n</script>\n</body>\n</html>\n";

app.get('/', (req, res) => {
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(QUIZ_HTML);
});

app.get('/api/status', (req, res) => {
  res.json({ status: 'ok', service: 'corretor-enem-backend' });
});

app.post('/api/analisar-redacao', async (req, res) => {
  try {
    if (!ANTHROPIC_API_KEY) {
      console.error('ANTHROPIC_API_KEY não configurada nas variáveis de ambiente.');
      return res.status(500).json({ error: 'Servidor não configurado (chave da API ausente).' });
    }

    const tema = (req.body && req.body.tema ? String(req.body.tema) : '').trim();
    const essay = (req.body && req.body.essay ? String(req.body.essay) : '').trim();
    const wordCount = essay ? essay.split(/\s+/).filter(Boolean).length : 0;

    if (wordCount < 50) {
      return res.status(400).json({ error: 'A redação precisa ter pelo menos 50 palavras.' });
    }

    const prompt = buildPrompt(tema, essay);

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1500,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Erro da API Anthropic:', data);
      return res.status(502).json({ error: (data && data.error && data.error.message) || 'Erro ao chamar a API da Anthropic.' });
    }

    const textBlock = (data.content || []).map(b => b.text || '').join('\n');
    const clean = textBlock.replace(/```json|```/g, '').trim();

    let analysis = null;
    const jsonStart = clean.indexOf('{');
    const jsonEnd = clean.lastIndexOf('}');
    if (jsonStart !== -1 && jsonEnd !== -1) {
      try {
        const parsed = JSON.parse(clean.slice(jsonStart, jsonEnd + 1));
        if (parsed && Array.isArray(parsed.competencias) && parsed.competencias.length >= 5) {
          analysis = parsed;
        }
      } catch (e) { /* tenta recuperação abaixo */ }
    }
    if (!analysis) {
      analysis = salvageAnalysis(clean);
    }
    if (!analysis || !Array.isArray(analysis.competencias) || analysis.competencias.length < 5) {
      console.error('Resposta da IA não pôde ser interpretada:', textBlock);
      return res.status(502).json({ error: 'Não foi possível interpretar a correção gerada. Tente novamente.' });
    }

    analysis.competencias = analysis.competencias.slice(0, 5).map((c, i) => ({
      numero: i + 1,
      titulo: COMP_TITLES[i],
      nota: typeof c.nota === 'number' ? c.nota : 0,
      comentario: c.comentario || ''
    }));
    if (typeof analysis.notaTotal !== 'number') {
      analysis.notaTotal = analysis.competencias.reduce((s, c) => s + c.nota, 0);
    }
    analysis.pontosFortes = analysis.pontosFortes || [];
    analysis.pontosFracos = analysis.pontosFracos || [];
    analysis.anotacoes = analysis.anotacoes || [];

    // Cria o pedido pendente — a análise completa fica só no servidor.
    const pedidoId = crypto.randomUUID();
    pendingAnalyses.set(pedidoId, {
      analysis,
      email: null,
      paid: false,
      createdAt: Date.now()
    });

    // Prévia: só a competência 1 completa + 1 ponto forte. O resto vem
    // como "locked" (sem nota nem comentário) até o pagamento ser confirmado.
    const teaser = {
      competencias: analysis.competencias.map((c, i) => (
        i <= 1 ? c : { numero: c.numero, titulo: c.titulo, locked: true }
      )),
      pontosFortes: analysis.pontosFortes.slice(0, 1),
      // Trecho real da análise crítica, seguido de uma continuação genérica —
      // isso garante que sempre tenha texto suficiente pra transbordar a
      // caixa no front e o efeito de desvanecer funcionar, mesmo quando a
      // IA gera uma crítica curta.
      analisePreview: ((analysis.pontosFracos && analysis.pontosFracos.length)
        ? analysis.pontosFracos.join('. ') + '.'
        : 'Identificamos pontos importantes a melhorar na sua redação.') +
        ' Esses pontos impactam diretamente sua nota final, principalmente na forma como as ideias se conectam ao longo dos parágrafos e na maneira como cada argumento é desenvolvido em relação ao'
    };

    res.json({ pedidoId, teaser });
  } catch (err) {
    console.error('Erro inesperado ao analisar redação:', err);
    res.status(500).json({ error: 'Erro inesperado no servidor.' });
  }
});

// Confere se o aluno já tem créditos comprados; se tiver, libera na hora
// (sem precisar pagar de novo). Se não tiver, só registra o e-mail no
// pedido pra casar com o webhook depois do checkout.
app.post('/api/desbloquear', (req, res) => {
  const { pedidoId, email } = req.body || {};
  if (!pedidoId || !pendingAnalyses.has(pedidoId)) {
    return res.status(404).json({ error: 'Pedido não encontrado.' });
  }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'E-mail inválido.' });
  }
  const emailNorm = email.trim().toLowerCase();
  const pedido = pendingAnalyses.get(pedidoId);
  pedido.email = emailNorm;

  const conta = contas.get(emailNorm);
  if (conta && conta.ilimitado) {
    pedido.paid = true;
    return res.json({ status: 'liberado', analysis: pedido.analysis, creditosRestantes: 'ilimitado' });
  }
  if (conta && conta.creditos > 0) {
    conta.creditos -= 1;
    pedido.paid = true;
    return res.json({ status: 'liberado', analysis: pedido.analysis, creditosRestantes: conta.creditos });
  }

  res.json({ status: 'precisa-pagar' });
});

// O front consulta essa rota (com polling) esperando o pagamento confirmar.
app.get('/api/status-pedido/:id', (req, res) => {
  const pedido = pendingAnalyses.get(req.params.id);
  if (!pedido) {
    return res.status(404).json({ error: 'Pedido não encontrado.' });
  }
  if (!pedido.paid) {
    return res.json({ paid: false });
  }
  res.json({ paid: true, analysis: pedido.analysis });
});

// Processa UM pedido pago (concede crédito se for um pacote de créditos).
// Reaproveitado tanto pro formato V1 (data é um objeto) quanto V2 (data é
// uma lista com todos os itens da mesma compra).
function processarPedidoPago(pedido) {
  if (!pedido || !pedido.customer || !pedido.customer.email) return;

  // Deduplicação: se a Cakto reenviar a mesma entrega, não conta duas vezes.
  if (pedido.id) {
    if (webhookProcessados.has(pedido.id)) {
      console.log('Pedido ' + pedido.id + ' já processado antes — ignorando reenvio.');
      return;
    }
    webhookProcessados.set(pedido.id, Date.now());
  }

  const email = String(pedido.customer.email).trim().toLowerCase();
  const nomeProduto = normalizar((pedido.product && pedido.product.name) || (pedido.offer && pedido.offer.name) || '');
  const ehVitalicio = nomeProduto.includes('vitalicio');
  const temCredito = nomeProduto.includes('credito');

  if (ehVitalicio) {
    // Acesso ilimitado — não conta crédito, só marca a conta como liberada
    // pra sempre (até o aluno decidir que não precisa mais).
    const contaAtual = contas.get(email) || { creditos: 0 };
    contaAtual.ilimitado = true;
    contas.set(email, contaAtual);
    console.log('Acesso vitalício concedido para ' + email);
  } else if (temCredito) {
    const numeroMatch = nomeProduto.match(/(\d+)/);
    const qtd = numeroMatch ? parseInt(numeroMatch[1], 10) : 1;
    const contaAtual = contas.get(email) || { creditos: 0 };
    contaAtual.creditos += qtd;
    contas.set(email, contaAtual);
    console.log('Créditos concedidos para ' + email + ': +' + qtd + ' (total agora: ' + contaAtual.creditos + ')');
  } else {
    // Provavelmente o order bump de conteúdo (PDF) — a própria Cakto já
    // entrega o arquivo automaticamente, nada a fazer aqui.
    console.log('Item aprovado sem padrão de crédito reconhecido (produto: "' + nomeProduto + '") — ignorado.');
  }
}

// Webhook da Cakto — chamado automaticamente quando um pagamento é aprovado.
app.post('/api/webhook/cakto', (req, res) => {
  try {
    const { secret, event, data } = req.body || {};

    if (!CAKTO_WEBHOOK_SECRET || secret !== CAKTO_WEBHOOK_SECRET) {
      console.error('Webhook da Cakto recebido com secret inválido.');
      return res.status(401).json({ error: 'unauthorized' });
    }

    // Responde 2xx rápido (a Cakto dá só 8s antes de considerar timeout);
    // o processamento aqui já é rápido o bastante pra não precisar de fila.
    if (event === 'purchase_approved' && data) {
      if (Array.isArray(data)) {
        // Webhook V2: um array com todos os itens da mesma compra
        // (principal + order bump + upsell/downsell).
        data.forEach(processarPedidoPago);
      } else {
        // Webhook V1: um único pedido por entrega.
        processarPedidoPago(data);
      }
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Erro ao processar webhook da Cakto:', err);
    res.status(200).json({ ok: true }); // responde 2xx mesmo assim pra evitar reenvios em loop
  }
});

function buildPrompt(tema, essay) {
  return 'Você é um corretor experiente de redações do ENEM. Avalie o texto abaixo seguindo os criterios oficiais das 5 competencias do ENEM, NESTA ORDEM. Cada competencia vale 0, 40, 80, 120, 160 ou 200 pontos (use apenas esses valores).\n\n' +
    '1: dominio da modalidade escrita formal da lingua portuguesa.\n' +
    '2: compreensao da proposta e aplicacao de conceitos de varias areas de conhecimento para desenvolver o tema.\n' +
    '3: selecao, organizacao e interpretacao de informacoes, fatos, opinioes e argumentos em defesa de um ponto de vista.\n' +
    '4: conhecimento dos mecanismos linguisticos necessarios para a construcao da argumentacao (coesao).\n' +
    '5: proposta de intervencao para o problema, respeitando os direitos humanos.\n\n' +
    'TEMA DA REDACAO: ' + (tema || '(nao informado pelo aluno)') + '\n\n' +
    'TEXTO DO ALUNO:\n"""\n' + essay + '\n"""\n\n' +
    'Responda APENAS com um objeto JSON valido, compacto, sem markdown, sem crases, sem quebras de linha dentro dos valores, sem texto antes ou depois. Formato EXATO, nesta ordem, 5 itens em "competencias":\n' +
    '{"notaTotal":numero,"competencias":[{"nota":numero,"comentario":"maximo 20 palavras"},{"nota":numero,"comentario":"maximo 20 palavras"},{"nota":numero,"comentario":"maximo 20 palavras"},{"nota":numero,"comentario":"maximo 20 palavras"},{"nota":numero,"comentario":"maximo 20 palavras"}],"pontosFortes":["curto","curto","curto"],"pontosFracos":["curto","curto","curto"],"anotacoes":[{"trecho":"copia EXATA de ate 8 palavras do texto do aluno","tipo":"erro","comentario":"maximo 14 palavras"},{"trecho":"copia EXATA de ate 8 palavras do texto do aluno","tipo":"elogio","comentario":"maximo 14 palavras"},{"trecho":"copia EXATA de ate 8 palavras do texto do aluno","tipo":"erro","comentario":"maximo 14 palavras"}]}';
}

// Recupera nota/comentário mesmo de um JSON cortado no meio.
function salvageAnalysis(text) {
  try {
    const compRegex = /\{\s*"nota"\s*:\s*(\d+)\s*,\s*"comentario"\s*:\s*"([^"]*)"\s*\}/g;
    const comps = [];
    let m;
    while ((m = compRegex.exec(text)) !== null && comps.length < 5) {
      comps.push({ nota: parseInt(m[1], 10), comentario: m[2] });
    }
    if (comps.length < 5) return null;

    const totalMatch = text.match(/"notaTotal"\s*:\s*(\d+)/);
    const notaTotal = totalMatch ? parseInt(totalMatch[1], 10) : comps.reduce((s, c) => s + c.nota, 0);

    function extractArray(key) {
      const re = new RegExp('"' + key + '"\\s*:\\s*\\[([^\\]]*)');
      const mm = text.match(re);
      if (!mm) return [];
      const out = [];
      const strRe = /"([^"]*)"/g;
      let sm;
      while ((sm = strRe.exec(mm[1])) !== null) { out.push(sm[1]); }
      return out;
    }
    const pontosFortes = extractArray('pontosFortes');
    const pontosFracos = extractArray('pontosFracos');

    const anotRegex = /\{\s*"trecho"\s*:\s*"([^"]*)"\s*,\s*"tipo"\s*:\s*"([^"]*)"\s*,\s*"comentario"\s*:\s*"([^"]*)"\s*\}/g;
    const anotacoes = [];
    let am;
    while ((am = anotRegex.exec(text)) !== null) { anotacoes.push({ trecho: am[1], tipo: am[2], comentario: am[3] }); }

    return { notaTotal, competencias: comps, pontosFortes, pontosFracos, anotacoes };
  } catch (e) { return null; }
}

app.listen(PORT, () => {
  console.log('Corretor ENEM backend rodando na porta ' + PORT);
});

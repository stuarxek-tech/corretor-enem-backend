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

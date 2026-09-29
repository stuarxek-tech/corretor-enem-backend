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

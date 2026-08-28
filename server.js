// ---------------------------------------------------------------
// Backend do Corretor de Redação ENEM
// Guarda a chave da API da Anthropic em segredo no servidor (nunca
// no navegador do aluno) e faz a análise da redação sob demanda.
// ---------------------------------------------------------------

const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors()); // libera chamadas vindas do domínio onde o quiz estiver hospedado
app.use(express.json({ limit: '1mb' }));

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
// Modelo real da API (diferente do usado no protótipo dentro do Claude).
// claude-sonnet-5 é um bom equilíbrio custo/qualidade para correção de texto.
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';

const COMP_TITLES = [
  'Domínio da norma culta',
  'Compreensão do tema',
  'Argumentação',
  'Coesão textual',
  'Proposta de intervenção'
];

// HTML embutido diretamente no código (não depende de encontrar um
// arquivo separado no disco depois do build/deploy).
const QUIZ_HTML = "<!DOCTYPE html>\n<html lang=\"pt-BR\">\n<head>\n<meta charset=\"UTF-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">\n<title>Quanto vale a sua redação?</title>\n<link rel=\"preconnect\" href=\"https://fonts.googleapis.com\">\n<link rel=\"preconnect\" href=\"https://fonts.gstatic.com\" crossorigin>\n<link rel=\"preconnect\" href=\"https://api.anthropic.com\">\n<link rel=\"dns-prefetch\" href=\"https://api.anthropic.com\">\n<link rel=\"stylesheet\" href=\"https://fonts.googleapis.com/css2?family=Kalam:wght@400;700&family=Source+Serif+4:opsz,wght@8..60,400;8..60,600;8..60,700&family=Inter:wght@400;500;600;700&display=swap\">\n<style>\n  :root{\n    --paper:#F7F3E8;\n    --paper-line: rgba(94,122,156,.16);\n    --paper-margin: rgba(179,38,30,.28);\n    --ink:#202B3B;\n    --ink-soft:#5B6B80;\n    --red:#B3261E;\n    --red-dark:#8C1D17;\n    --red-soft:#F5DBD8;\n    --good:#2F6F5E;\n    --good-soft:#DCEDE7;\n    --surface:#FFFFFF;\n    --shadow: rgba(32,43,59,.12);\n    --font-display:'Source Serif 4', Georgia, serif;\n    --font-hand:'Kalam', cursive;\n    --font-body:'Inter', system-ui, sans-serif;\n  }\n  *{box-sizing:border-box;}\n  html,body{margin:0;padding:0;}\n  body{\n    background:\n      linear-gradient(90deg, transparent 0 46px, var(--paper-margin) 46px 47px, transparent 47px 100%),\n      repeating-linear-gradient(var(--paper) 0 31px, var(--paper-line) 31px 32px),\n      var(--paper);\n    font-family: var(--font-body);\n    color: var(--ink);\n    min-height:100vh;\n    -webkit-font-smoothing:antialiased;\n  }\n  #app{max-width:640px;margin:0 auto;padding:36px 22px 70px;min-height:100vh;}\n  .eyebrow{\n    font-family:var(--font-hand);\n    color:var(--red);\n    font-size:19px;\n    transform:rotate(-2deg);\n    display:inline-block;\n    margin-bottom:6px;\n  }\n  h1{font-family:var(--font-display);font-weight:700;font-size:34px;line-height:1.15;margin:0 0 14px;color:var(--ink);}\n  h2{font-family:var(--font-display);font-weight:600;font-size:24px;margin:0 0 10px;color:var(--ink);}\n  p.lead{color:var(--ink-soft);font-size:16px;line-height:1.55;margin:0 0 26px;}\n  .card{\n    background:var(--surface);\n    border-radius:14px;\n    box-shadow:0 10px 30px var(--shadow);\n    padding:24px;\n  }\n  .btn{\n    font-family:var(--font-body);\n    font-weight:600;\n    font-size:15.5px;\n    border:none;\n    border-radius:10px;\n    padding:15px 22px;\n    cursor:pointer;\n    transition:transform .15s ease, box-shadow .15s ease;\n    width:100%;\n  }\n  .btn:active{transform:scale(.98);}\n  .btn-primary{background:var(--red);color:#fff;box-shadow:0 8px 20px rgba(179,38,30,.28);}\n  .btn-primary:hover{background:var(--red-dark);}\n  .btn-ghost{background:transparent;color:var(--ink-soft);border:1.5px solid #DCD5C4;}\n  .progress-wrap{display:flex;gap:6px;margin-bottom:28px;}\n  .progress-seg{height:5px;flex:1;background:#E5DFCF;border-radius:3px;overflow:hidden;}\n  .progress-seg > div{height:100%;background:var(--red);width:0%;transition:width .4s ease;}\n  .qnum{font-family:var(--font-hand);color:var(--ink-soft);font-size:16px;margin-bottom:6px;}\n  .option{\n    display:block;width:100%;text-align:left;\n    background:var(--surface);border:1.5px solid #E5DFCF;border-radius:12px;\n    padding:16px 18px;margin-bottom:10px;font-size:15.5px;color:var(--ink);\n    cursor:pointer;transition:border-color .15s ease, background .15s ease;\n    font-family:var(--font-body);\n  }\n  .option:hover{border-color:var(--red);background:#FFF9F8;}\n  .stamp-wrap{display:flex;justify-content:center;margin:6px 0 24px;}\n  .stamp{\n    width:150px;height:150px;border-radius:50%;\n    border:4px solid var(--red);\n    display:flex;flex-direction:column;align-items:center;justify-content:center;\n    transform:rotate(-8deg);\n    font-family:var(--font-display);\n    color:var(--red);\n    box-shadow:0 0 0 3px rgba(179,38,30,.08);\n  }\n  .stamp .n{font-size:40px;font-weight:700;line-height:1;}\n  .stamp .d{font-family:var(--font-hand);font-size:14px;margin-top:2px;}\n  .checklist{list-style:none;padding:0;margin:22px 0;}\n  .checklist li{\n    display:flex;align-items:center;gap:10px;padding:10px 0;\n    color:var(--ink-soft);font-size:15px;\n    opacity:0;animation:fadeIn .5s ease forwards;\n  }\n  .checklist li:nth-child(1){animation-delay:.2s;}\n  .checklist li:nth-child(2){animation-delay:1s;}\n  .checklist li:nth-child(3){animation-delay:1.8s;}\n  .checklist li .dot{width:20px;height:20px;border-radius:50%;border:2px solid var(--good);flex:none;position:relative;}\n  .checklist li .dot::after{content:'';position:absolute;left:5px;top:2px;width:5px;height:9px;border:solid var(--good);border-width:0 2px 2px 0;transform:rotate(45deg);}\n  @keyframes fadeIn{to{opacity:1;}}\n  textarea, input[type=text]{\n    width:100%;font-family:var(--font-body);font-size:15.5px;color:var(--ink);\n    border:1.5px solid #E5DFCF;border-radius:10px;padding:14px;\n    background:#FFFEFB;resize:vertical;\n  }\n  textarea{min-height:260px;line-height:1.7;}\n  label.field-label{display:block;font-size:13px;font-weight:600;color:var(--ink-soft);text-transform:uppercase;letter-spacing:.04em;margin:18px 0 6px;}\n  .word-count{font-size:13px;color:var(--ink-soft);margin-top:6px;text-align:right;}\n  .word-count.ok{color:var(--good);}\n  .pen-loader{display:flex;flex-direction:column;align-items:center;padding:60px 20px;}\n  .pen-emoji{font-size:44px;animation:wiggle 1s ease-in-out infinite;}\n  @keyframes wiggle{0%,100%{transform:rotate(-8deg);}50%{transform:rotate(8deg);}}\n  .loading-msg{font-family:var(--font-hand);font-size:19px;color:var(--ink-soft);margin-top:18px;text-align:center;min-height:28px;}\n  .blur{filter:blur(6px);user-select:none;pointer-events:none;}\n  .lock-badge{\n    display:inline-flex;align-items:center;gap:6px;background:var(--ink);color:#fff;\n    font-size:12px;font-weight:600;padding:5px 10px;border-radius:20px;margin-bottom:10px;\n  }\n  .paywall-cta{\n    margin-top:22px;padding:20px;border-radius:14px;\n    background:linear-gradient(180deg,#fff, #FFF6F5);\n    border:1.5px dashed var(--red);\n    text-align:center;\n  }\n  .comp-row{margin-bottom:18px;}\n  .comp-head{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px;}\n  .comp-title{font-weight:600;font-size:14.5px;}\n  .comp-score{font-family:var(--font-display);font-weight:700;color:var(--red);}\n  .comp-bar{height:8px;background:#EDE7D8;border-radius:5px;overflow:hidden;}\n  .comp-bar > div{height:100%;background:var(--red);border-radius:5px;}\n  .comp-comment{font-size:13.5px;color:var(--ink-soft);margin-top:5px;line-height:1.4;}\n  .cols{display:flex;gap:16px;margin-top:22px;}\n  .col{flex:1;background:#FBFAF5;border-radius:12px;padding:14px 16px;}\n  .col h3{font-size:13px;text-transform:uppercase;letter-spacing:.03em;margin:0 0 10px;color:var(--ink-soft);}\n  .col.good h3{color:var(--good);}\n  .col.bad h3{color:var(--red);}\n  .col ul{margin:0;padding-left:18px;font-size:13.5px;line-height:1.6;}\n  .essay-box{\n    margin-top:24px;background:#FFFEFB;border:1.5px solid #E5DFCF;border-radius:12px;\n    padding:20px;font-family:var(--font-body);font-size:15px;line-height:1.85;white-space:pre-wrap;\n  }\n  mark.err{background:none;color:var(--red);text-decoration:underline wavy var(--red);text-underline-offset:3px;font-weight:600;}\n  mark.ok{background:var(--good-soft);color:var(--good);border-radius:3px;padding:0 2px;font-weight:600;}\n  sup{font-family:var(--font-hand);color:var(--red);font-size:13px;}\n  .notes{list-style:none;padding:0;margin:14px 0 0;}\n  .notes li{display:flex;gap:8px;font-size:13.5px;color:var(--ink-soft);padding:6px 0;border-top:1px dashed #E5DFCF;}\n  .notes li b{color:var(--red);font-family:var(--font-hand);font-size:15px;}\n  .top-nav{display:flex;justify-content:space-between;align-items:center;margin-bottom:18px;}\n  .top-nav .brand{font-family:var(--font-hand);font-size:18px;color:var(--red);}\n  .footer-note{font-size:12px;color:var(--ink-soft);text-align:center;margin-top:26px;opacity:.7;}\n  .error-box{background:#FFF3F2;border:1.5px solid var(--red-soft);color:var(--red-dark);padding:14px 16px;border-radius:10px;font-size:14px;margin-top:14px;}\n</style>\n</head>\n<body>\n<div id=\"app\"></div>\n\n<script>\n// ---------------------------------------------------------------\n// PROTÓTIPO — Corretor de Redação ENEM (quiz + análise por IA)\n// Paywall está em modo DEMONSTRAÇÃO: o botão libera o resultado\n// direto. Para produção, troque unlockResult() por um redirect\n// para o checkout real (ex: Cakto) e só chame renderResult()\n// depois de confirmar o pagamento (via retorno de URL / webhook).\n// ---------------------------------------------------------------\n\nconst QUESTIONS = [\n  {\n    q: \"Quantas vezes você já treinou uma redação nota 1000?\",\n    options: [\"Nunca treinei\", \"Já tentei, mas travo no meio\", \"Escrevo bem, quero afinar detalhes\", \"Não sei nem por onde começar\"]\n  },\n  {\n    q: \"Qual competência mais te assusta?\",\n    options: [\"Competência 1 — Gramática e norma culta\", \"Competência 2 — Repertório sociocultural\", \"Competência 3 — Argumentação\", \"Competência 4 — Coesão textual\", \"Competência 5 — Proposta de intervenção\"]\n  },\n  {\n    q: \"Qual sua meta de nota na redação?\",\n    options: [\"Acima de 900\", \"Entre 800 e 900\", \"Entre 600 e 800\", \"Só passar de 600\"]\n  },\n  {\n    q: \"Quando é sua prova?\",\n    options: [\"Nas próximas semanas\", \"Nos próximos meses\", \"Ano que vem\", \"Ainda não sei\"]\n  },\n  {\n    q: \"O que você mais precisa agora?\",\n    options: [\"Saber minha nota real\", \"Entender meus erros específicos\", \"Um plano pra evoluir\", \"Confiança pro dia da prova\"]\n  }\n];\n\nconst LOADING_MESSAGES = [\n  \"Lendo sua redação com calma...\",\n  \"Avaliando domínio da norma culta...\",\n  \"Conferindo o repertório sociocultural...\",\n  \"Analisando a força dos seus argumentos...\",\n  \"Checando a coesão entre parágrafos...\",\n  \"Avaliando sua proposta de intervenção...\",\n  \"Fechando a correção...\"\n];\n\nlet state = {\n  screen: 'welcome',\n  quizIndex: 0,\n  answers: [],\n  tema: '',\n  essay: '',\n  analysis: null,\n  error: '',\n  errorDetail: ''\n};\n\nfunction setState(patch){ state = Object.assign({}, state, patch); render(); }\nfunction el(id){ return document.getElementById(id); }\n\nfunction escapeHtml(str){\n  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\"/g,'&quot;').replace(/'/g,'&#39;');\n}\n\n// ---------- Navegação ----------\nwindow.startQuiz = function(){ setState({screen:'quiz', quizIndex:0, answers:[]}); };\n\nwindow.selectAnswer = function(optIndex){\n  const answers = state.answers.concat([QUESTIONS[state.quizIndex].options[optIndex]]);\n  if(state.quizIndex + 1 < QUESTIONS.length){\n    setState({answers, quizIndex: state.quizIndex + 1});\n  } else {\n    setState({answers, screen:'transition'});\n    setTimeout(()=> setState({screen:'essay'}), 2600);\n  }\n};\n\nwindow.goSubmitEssay = function(){\n  const tema = el('temaInput').value.trim();\n  const essay = el('essayInput').value.trim();\n  const wc = essay ? essay.split(/\\s+/).filter(Boolean).length : 0;\n  if(wc < 50){\n    setState({tema, essay, error:'Sua redação precisa ter pelo menos 50 palavras para uma análise completa (atual: ' + wc + ').'});\n    return;\n  }\n  setState({tema, essay, error:'', screen:'analyzing'});\n  analyzeEssay(tema, essay);\n};\n\nwindow.unlockResult = function(){\n  // DEMO: aqui entraria a confirmação real de pagamento (Cakto etc.)\n  setState({screen:'result'});\n};\n\nwindow.restart = function(){\n  setState({screen:'welcome', quizIndex:0, answers:[], tema:'', essay:'', analysis:null, error:'', errorDetail:''});\n};\n\n// ---------- Chamada à IA ----------\n// Tenta até 3x automaticamente (com pequeno intervalo) antes de mostrar\n// qualquer erro pro aluno. A tela permanece em \"analyzing\" durante as\n// tentativas — quem está do outro lado só vê o loading rodando.\nconst MAX_ATTEMPTS = 3;\n\n// Como o quiz e o backend agora estão no mesmo domínio, um caminho\n// relativo funciona direto — não precisa editar nada aqui.\nconst BACKEND_URL = '/api/analisar-redacao';\n\nasync function analyzeEssay(tema, essay, attempt){\n  attempt = attempt || 1;\n\n  try{\n    const response = await fetch(BACKEND_URL, {\n      method: \"POST\",\n      headers: { \"Content-Type\": \"application/json\" },\n      body: JSON.stringify({ tema, essay })\n    });\n    const data = await response.json();\n    if(!response.ok || data.error){\n      throw new Error((data && data.error) || ('Resposta HTTP ' + response.status));\n    }\n    const analysis = data.analysis;\n    if(!analysis || !Array.isArray(analysis.competencias) || analysis.competencias.length < 5){\n      throw new Error('Resposta do backend veio incompleta');\n    }\n    setState({ analysis, screen:'paywall' });\n  } catch(err){\n    console.error('Erro ao analisar redação (tentativa ' + attempt + ' de ' + MAX_ATTEMPTS + '):', err);\n    if(attempt < MAX_ATTEMPTS){\n      setTimeout(() => analyzeEssay(tema, essay, attempt + 1), 900);\n    } else {\n      const detail = (err && err.name ? err.name + ': ' : '') + ((err && err.message) || String(err));\n      setState({ screen:'error', error:'Não consegui analisar sua redação agora.', errorDetail: detail });\n    }\n  }\n}\n\n// ---------- Render ----------\nfunction render(){\n  const app = el('app') || document.getElementById('app');\n  switch(state.screen){\n    case 'welcome': app.innerHTML = screenWelcome(); break;\n    case 'quiz': app.innerHTML = screenQuiz(); break;\n    case 'transition': app.innerHTML = screenTransition(); break;\n    case 'essay': app.innerHTML = screenEssay(); break;\n    case 'analyzing': app.innerHTML = screenAnalyzing(); startLoadingRotation(); break;\n    case 'paywall': app.innerHTML = screenPaywall(); break;\n    case 'result': app.innerHTML = screenResult(); break;\n    case 'error': app.innerHTML = screenError(); break;\n  }\n}\n\nfunction topNav(brand){\n  return '<div class=\"top-nav\"><span class=\"brand\">' + brand + '</span></div>';\n}\n\nfunction screenWelcome(){\n  return topNav('✎ Corretor ENEM') +\n  '<span class=\"eyebrow\">correção nas 5 competências</span>' +\n  '<h1>Quanto vale a sua redação, de verdade?</h1>' +\n  '<p class=\"lead\">Responda 5 perguntas rápidas, cole sua redação e receba uma correção detalhada — competência por competência, do jeito que cai na prova.</p>' +\n  '<div class=\"card\">' +\n    '<button class=\"btn btn-primary\" onclick=\"startQuiz()\">Começar avaliação →</button>' +\n  '</div>' +\n  '<p class=\"footer-note\">5 perguntas rápidas + sua redação = diagnóstico completo</p>';\n}\n\nfunction screenQuiz(){\n  const total = QUESTIONS.length;\n  const q = QUESTIONS[state.quizIndex];\n  let segs = '';\n  for(let i=0;i<total;i++){\n    const fill = i < state.quizIndex ? '100%' : (i === state.quizIndex ? '60%' : '0%');\n    segs += '<div class=\"progress-seg\"><div style=\"width:' + fill + '\"></div></div>';\n  }\n  let opts = '';\n  q.options.forEach((o,i) => {\n    opts += '<button class=\"option\" onclick=\"selectAnswer(' + i + ')\">' + escapeHtml(o) + '</button>';\n  });\n  return topNav('✎ Corretor ENEM') +\n  '<div class=\"progress-wrap\">' + segs + '</div>' +\n  '<div class=\"qnum\">Pergunta ' + (state.quizIndex+1) + ' de ' + total + '</div>' +\n  '<h2>' + escapeHtml(q.q) + '</h2>' +\n  '<div style=\"margin-top:18px;\">' + opts + '</div>';\n}\n\nfunction screenTransition(){\n  const foco = state.answers[1] || 'seus principais pontos fracos';\n  const meta = state.answers[2] || 'uma nota melhor';\n  return '<div class=\"pen-loader\">' +\n    '<div class=\"stamp-wrap\"><div class=\"stamp\"><div class=\"n\">✎</div><div class=\"d\">analisando</div></div></div>' +\n    '<h2 style=\"text-align:center;\">Montando seu diagnóstico...</h2>' +\n    '<ul class=\"checklist\" style=\"max-width:360px;\">' +\n      '<li><span class=\"dot\"></span> Perfil identificado: foco em ' + escapeHtml(foco) + '</li>' +\n      '<li><span class=\"dot\"></span> Meta traçada: ' + escapeHtml(meta) + '</li>' +\n      '<li><span class=\"dot\"></span> Preparando tela para colar sua redação</li>' +\n    '</ul>' +\n  '</div>';\n}\n\nfunction screenEssay(){\n  const errBox = state.error ? '<div class=\"error-box\">' + escapeHtml(state.error) + '</div>' : '';\n  return topNav('✎ Corretor ENEM') +\n  '<h2>Cole sua redação abaixo</h2>' +\n  '<p class=\"lead\">Quanto mais fiel ao texto final, mais precisa é a correção.</p>' +\n  '<label class=\"field-label\">Tema da redação (opcional)</label>' +\n  '<input type=\"text\" id=\"temaInput\" placeholder=\"Ex: Desafios para a valorização de comunidades tradicionais no Brasil\" value=\"' + escapeHtml(state.tema) + '\">' +\n  '<label class=\"field-label\">Sua redação</label>' +\n  '<textarea id=\"essayInput\" placeholder=\"Cole aqui o texto completo da sua redação...\">' + escapeHtml(state.essay) + '</textarea>' +\n  errBox +\n  '<button class=\"btn btn-primary\" style=\"margin-top:18px;\" onclick=\"goSubmitEssay()\">Analisar minha redação</button>';\n}\n\nfunction screenAnalyzing(){\n  return '<div class=\"pen-loader\">' +\n    '<div class=\"pen-emoji\">✎</div>' +\n    '<div class=\"loading-msg\" id=\"loadingMsg\">' + LOADING_MESSAGES[0] + '</div>' +\n  '</div>';\n}\n\nlet loadingInterval = null;\nfunction startLoadingRotation(){\n  if(loadingInterval) clearInterval(loadingInterval);\n  let i = 0;\n  loadingInterval = setInterval(() => {\n    i = (i+1) % LOADING_MESSAGES.length;\n    const node = el('loadingMsg');\n    if(node) node.textContent = LOADING_MESSAGES[i]; else clearInterval(loadingInterval);\n  }, 1400);\n}\n\nfunction screenPaywall(){\n  const a = state.analysis;\n  const c1 = a.competencias[0];\n  const fortesPreview = a.pontosFortes[0] || 'seus pontos fortes identificados na correção';\n  return topNav('✎ Corretor ENEM') +\n  '<span class=\"lock-badge\">🔒 correção pronta</span>' +\n  '<h2>Sua redação já foi corrigida!</h2>' +\n  '<p class=\"lead\">Veja uma prévia — o restante da correção está bloqueado.</p>' +\n  '<div class=\"card\">' +\n    '<div class=\"comp-row\">' +\n      '<div class=\"comp-head\"><span class=\"comp-title\">' + escapeHtml(c1.titulo) + '</span><span class=\"comp-score\">' + c1.nota + '/200</span></div>' +\n      '<div class=\"comp-bar\"><div style=\"width:' + (c1.nota/200*100) + '%\"></div></div>' +\n      '<div class=\"comp-comment\">' + escapeHtml(c1.comentario) + '</div>' +\n    '</div>' +\n    '<div class=\"blur\">' +\n      buildCompRow(a.competencias[1]) + buildCompRow(a.competencias[2]) +\n      buildCompRow(a.competencias[3]) + buildCompRow(a.competencias[4]) +\n    '</div>' +\n    '<div class=\"cols\">' +\n      '<div class=\"col good\"><h3>Pontos fortes</h3><ul><li>' + escapeHtml(fortesPreview) + '</li></ul></div>' +\n      '<div class=\"col bad blur\"><h3>Pontos a melhorar</h3><ul><li>bloqueado</li><li>bloqueado</li></ul></div>' +\n    '</div>' +\n    '<div class=\"paywall-cta\">' +\n      '<div style=\"font-family:var(--font-hand);font-size:22px;color:var(--red);margin-bottom:4px;\">nota final bloqueada</div>' +\n      '<p style=\"font-size:13.5px;color:var(--ink-soft);margin:0 0 14px;\">Desbloqueie a nota total, as 5 competências completas e a redação anotada com as correções.</p>' +\n      '<button class=\"btn btn-primary\" onclick=\"unlockResult()\">🔓 Ver resultado completo (modo demonstração)</button>' +\n    '</div>' +\n  '</div>' +\n  '<p class=\"footer-note\">No produto final, este botão leva ao checkout real e só libera após confirmação de pagamento.</p>';\n}\n\nfunction buildCompRow(c){\n  return '<div class=\"comp-row\">' +\n    '<div class=\"comp-head\"><span class=\"comp-title\">' + escapeHtml(c.titulo) + '</span><span class=\"comp-score\">' + c.nota + '/200</span></div>' +\n    '<div class=\"comp-bar\"><div style=\"width:' + (c.nota/200*100) + '%\"></div></div>' +\n    '<div class=\"comp-comment\">' + escapeHtml(c.comentario) + '</div>' +\n  '</div>';\n}\n\nfunction screenResult(){\n  const a = state.analysis;\n  let compsHtml = '';\n  a.competencias.forEach(c => { compsHtml += buildCompRow(c); });\n\n  let fortesHtml = '', fracosHtml = '';\n  (a.pontosFortes||[]).forEach(p => fortesHtml += '<li>' + escapeHtml(p) + '</li>');\n  (a.pontosFracos||[]).forEach(p => fracosHtml += '<li>' + escapeHtml(p) + '</li>');\n\n  // Anotações sobre o texto original\n  let essayEscaped = escapeHtml(state.essay);\n  let notesHtml = '';\n  (a.anotacoes||[]).forEach((n, idx) => {\n    const trechoEsc = escapeHtml(n.trecho || '');\n    if(trechoEsc && essayEscaped.indexOf(trechoEsc) !== -1){\n      const cls = n.tipo === 'elogio' ? 'ok' : 'err';\n      const marked = '<mark class=\"' + cls + '\">' + trechoEsc + '<sup>' + (idx+1) + '</sup></mark>';\n      essayEscaped = essayEscaped.replace(trechoEsc, marked);\n    }\n    notesHtml += '<li><b>' + (idx+1) + '.</b> ' + escapeHtml(n.comentario || '') + '</li>';\n  });\n\n  return topNav('✎ Corretor ENEM') +\n  '<div class=\"stamp-wrap\"><div class=\"stamp\"><div class=\"n\">' + a.notaTotal + '</div><div class=\"d\">/ 1000</div></div></div>' +\n  '<h2 style=\"text-align:center;\">Correção completa</h2>' +\n  '<div class=\"card\">' +\n    compsHtml +\n    '<div class=\"cols\">' +\n      '<div class=\"col good\"><h3>Pontos fortes</h3><ul>' + fortesHtml + '</ul></div>' +\n      '<div class=\"col bad\"><h3>Pontos a melhorar</h3><ul>' + fracosHtml + '</ul></div>' +\n    '</div>' +\n  '</div>' +\n  '<h2 style=\"margin-top:28px;\">Sua redação anotada</h2>' +\n  '<div class=\"essay-box\">' + essayEscaped + '</div>' +\n  '<ul class=\"notes\">' + notesHtml + '</ul>' +\n  '<button class=\"btn btn-ghost\" style=\"margin-top:26px;\" onclick=\"restart()\">Analisar outra redação</button>';\n}\n\nfunction screenError(){\n  const detail = state.errorDetail ? '<details style=\"margin-top:10px;\"><summary style=\"cursor:pointer;font-size:12.5px;color:var(--ink-soft);\">Detalhes técnicos</summary><pre style=\"white-space:pre-wrap;font-size:12px;background:#F3EFE3;border-radius:8px;padding:10px;margin-top:6px;color:var(--ink-soft);font-family:monospace;\">' + escapeHtml(state.errorDetail) + '</pre></details>' : '';\n  return topNav('✎ Corretor ENEM') +\n  '<h2>Algo não saiu como esperado</h2>' +\n  '<div class=\"error-box\">' + escapeHtml(state.error) + detail + '</div>' +\n  '<button class=\"btn btn-primary\" style=\"margin-top:18px;\" onclick=\"setState({screen:\\'essay\\', errorDetail:\\'\\'})\">Tentar novamente</button>';\n}\n\nrender();\n</script>\n</body>\n</html>\n";

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

    res.json({ analysis });
  } catch (err) {
    console.error('Erro inesperado ao analisar redação:', err);
    res.status(500).json({ error: 'Erro inesperado no servidor.' });
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

// ---------------------------------------------------------------
// Backend do Corretor de Redação ENEM
// Guarda a chave da API da Anthropic em segredo no servidor (nunca
// no navegador do aluno) e faz a análise da redação sob demanda.
// ---------------------------------------------------------------

const express = require('express');
const cors = require('cors');
const path = require('path');

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

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'redacao-enem-quiz.html'));
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

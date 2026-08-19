const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const agentCoreV17 = require('./agent-core-v17');

const groqApiKey = defineSecret('GROQ_API_KEY');
const githubToken = defineSecret('NEXUS_GITHUB_TOKEN');
const geminiApiKey = defineSecret('GEMINI_API_KEY');

const AUTHORIZED_EMAIL = 'giva.norberto@gmail.com';
const MAX_PROMPT_CHARS = 4000;

function assertAuthorized(request) {
  const email = String(request.auth?.token?.email || '').toLowerCase();
  if (!request.auth || email !== AUTHORIZED_EMAIL) {
    throw new HttpsError('permission-denied', 'Usuário não autorizado.');
  }
}

function normalize(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function isArchitectureQuestion(prompt) {
  return /arquitetura|risco tecnico|riscos tecnicos|seguranca|ci\/cd|pipeline|deploy|auditoria|audit|infraestrutura|secret|segredo|firestore rules|storage rules|governanca/.test(normalize(prompt));
}

function epistemicProtocol(prompt) {
  return [
    prompt,
    '',
    'PROTOCOLO EPISTÊMICO OBRIGATÓRIO DESTA AUDITORIA:',
    '1. Classifique cada conclusão relevante como CONFIRMADO, PROVÁVEL, NÃO VERIFICADO ou RECOMENDAÇÃO.',
    '2. CONFIRMADO = sustentado diretamente por inventário, arquivo, configuração ou dado efetivamente consultado nesta execução.',
    '3. PROVÁVEL = inferência plausível, mas não comprovada; explique a evidência que sustenta a inferência e nunca a apresente como fato.',
    '4. NÃO VERIFICADO = depende de estado externo ou runtime não consultado nesta execução, como Rules efetivamente implantadas no Firebase, IAM em produção, billing, configuração do Console ou política operacional fora do repositório.',
    '5. RECOMENDAÇÃO = ação proposta; nunca descreva uma recomendação como se fosse condição atual do sistema.',
    '6. Se firestore.rules ou storage.rules não estiverem versionados no GitHub, conclua apenas que as regras NÃO ESTÃO VERSIONADAS NO REPOSITÓRIO. O estado das Rules implantadas em produção deve ser classificado como NÃO VERIFICADO. Não especule que dados estão públicos, expostos ou acessíveis sem consultar as Rules implantadas.',
    '7. A ausência de deploy automático de Cloud Functions no workflow não é, por si só, um risco: neste projeto o deploy de Functions exige aprovação humana. O risco técnico a avaliar é a ausência de validação automatizada antes do deploy manual, caso isso seja comprovado.',
    '8. Se uma política de rotação de secrets não aparecer no repositório, diga apenas que ela NÃO FOI IDENTIFICADA NO REPOSITÓRIO; não diga que ela não existe.',
    '9. A expressão não encontrei nunca pode ser convertida em não existe sem uma fonte que cubra integralmente o domínio analisado.',
    '10. Diferencie explicitamente o que foi verificado no GitHub do que exigiria consulta ao Firebase/Google Cloud em produção.',
    '',
    'FORMATO OBRIGATÓRIO PARA CADA RISCO:',
    '### <número>. <título>',
    '**Classificação:** CONFIRMADO | PROVÁVEL | NÃO VERIFICADO | RECOMENDAÇÃO',
    '**Evidência:** <fonte concreta>',
    '**Conclusão:** <o que a evidência realmente permite afirmar>',
    '**Limite da evidência:** <o que não foi verificado, se aplicável>',
    '',
    'No final, informe qual risco priorizaria e separe claramente a ação recomendada do fato observado.'
  ].join('\n');
}

function criticalCorrections(answer) {
  const text = String(answer || '');
  const normalized = normalize(text);
  const corrections = [];

  const runtimeRulesSpeculation =
    /regras padrao|qualquer cliente|cliente anonimo|ate anonimo|dados (?:ficam|estao|podem ficar) (?:publicos|expostos)|acesso irrestrito/.test(normalized);
  if (runtimeRulesSpeculation) {
    corrections.push(
      '**NÃO VERIFICADO — Rules em produção:** o inventário do GitHub só comprova se arquivos de Rules estão ou não versionados. Ele não comprova quais Rules estão implantadas no Firebase nem o nível real de acesso em produção.'
    );
  }

  const rotationOverclaim =
    /nao existe.{0,80}rotacao|ausencia.{0,80}politica de rotacao|sem politica de rotacao/.test(normalized);
  if (rotationOverclaim) {
    corrections.push(
      '**NÃO VERIFICADO — rotação de secrets:** a ausência de uma política no repositório significa apenas que ela não foi identificada no código versionado; uma política operacional pode existir fora do GitHub.'
    );
  }

  const automaticFunctionsDeployAsRequirement =
    /implementar.{0,80}deploy automatico.{0,80}functions|automatizar.{0,80}deploy.{0,80}functions/.test(normalized);
  if (automaticFunctionsDeployAsRequirement) {
    corrections.push(
      '**RECOMENDAÇÃO corrigida — Functions:** preserve o deploy manual/aprovado. Automatize primeiro validações como sintaxe, lint e testes; não transforme o deploy de Functions em automático sem decisão explícita de governança.'
    );
  }

  if (!corrections.length) return text;

  return [
    text,
    '',
    '---',
    '### Validador epistemológico do Nexus',
    ...corrections,
    '',
    'As correções acima prevalecem sobre qualquer afirmação mais forte no corpo da resposta.'
  ].join('\n');
}

exports.askNexusAgent = onCall(
  {
    region: 'southamerica-east1',
    secrets: [groqApiKey, githubToken, geminiApiKey],
    maxInstances: 1,
    timeoutSeconds: 120,
    memory: '512MiB'
  },
  async (request) => {
    assertAuthorized(request);

    const prompt = String(request.data?.prompt || '').trim();
    if (!prompt) throw new HttpsError('invalid-argument', 'Informe uma pergunta.');
    if (prompt.length > MAX_PROMPT_CHARS) {
      throw new HttpsError('invalid-argument', `Pergunta limitada a ${MAX_PROMPT_CHARS} caracteres.`);
    }

    const guarded = isArchitectureQuestion(prompt);
    const routedRequest = guarded
      ? {
          ...request,
          data: {
            ...(request.data || {}),
            prompt: epistemicProtocol(prompt)
          }
        }
      : request;

    const result = await agentCoreV17.askNexusAgent.run(routedRequest);

    return {
      ...result,
      answer: guarded ? criticalCorrections(result?.answer) : result?.answer,
      version: '1.8',
      epistemicGuard: guarded,
      epistemicClasses: guarded
        ? ['CONFIRMADO', 'PROVÁVEL', 'NÃO VERIFICADO', 'RECOMENDAÇÃO']
        : undefined
    };
  }
);

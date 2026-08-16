# Arquitetura inicial do Nexus

## Objetivo

O Nexus é o agente central de engenharia, auditoria e operação assistida dos projetos. Ele deve acumular memória técnica, observar os sistemas, investigar problemas e preparar correções sem executar mudanças destrutivas ou de produção sem aprovação.

## Autonomia permitida

- leitura de repositórios e telemetria;
- investigação de bugs;
- atualização de dossiê técnico;
- criação de branch isolada;
- preparação de código e testes;
- revisão automática por segundo motor;
- abertura de Pull Request;
- alertas e relatórios.

## Ações protegidas

Exigem aprovação explícita:

- escrita em dados de produção;
- exclusão de dados;
- alteração de regras ou permissões;
- merge;
- deploy;
- habilitação de provedor pago ou operação com custo;
- qualquer ação irreversível.

## Regra de segurança

`default deny`: se o Nexus não conseguir provar que uma ação é segura, reversível e autorizada, ele não executa.

## Evolução prevista

1. Painel e memória local.
2. GitHub em modo leitura.
3. Firebase em modo leitura com Cost Firewall.
4. Motor de IA gratuito e roteador.
5. Investigação autônoma.
6. Código + testes + revisão cruzada.
7. Pull Request automático.
8. Monitoramento e relatórios.
9. Merge/deploy apenas mediante aprovação humana.

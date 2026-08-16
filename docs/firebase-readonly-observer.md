# Nexus — observador Firebase somente leitura

## Objetivo

Permitir que o Nexus consulte dados operacionais reais de projetos Firebase autorizados sem conceder permissão de escrita.

Primeiro projeto habilitado no código:

- ListaLar → `compras-da-casa`

## Identidade de runtime do Nexus

As Functions v2 usam por padrão a conta de serviço de runtime do Compute Engine. No projeto Nexus (`288616302811`), a identidade esperada é:

`288616302811-compute@developer.gserviceaccount.com`

Antes de aplicar permissões, confirme no Google Cloud Console / Cloud Run functions que as Functions do Nexus realmente estão executando com essa conta. Se uma conta de serviço customizada estiver configurada, use a identidade exibida lá.

## Permissões mínimas no projeto alvo

Conceder somente leitura no projeto `compras-da-casa`:

- `roles/firebaseauth.viewer` — leitura dos usuários do Firebase Authentication.
- `roles/datastore.viewer` — leitura de recursos Firestore/Datastore, necessária para listar coleções sem escrita.

Exemplo com gcloud, após confirmar a identidade de runtime:

```bash
gcloud projects add-iam-policy-binding compras-da-casa \
  --member="serviceAccount:288616302811-compute@developer.gserviceaccount.com" \
  --role="roles/firebaseauth.viewer"

gcloud projects add-iam-policy-binding compras-da-casa \
  --member="serviceAccount:288616302811-compute@developer.gserviceaccount.com" \
  --role="roles/datastore.viewer"
```

Esses comandos alteram IAM e, pela governança do Nexus, só devem ser executados com aprovação humana explícita.

## O que o observador lê

- total de usuários do Firebase Authentication;
- usuários habilitados/desabilitados;
- e-mails verificados;
- usuários com login nos últimos 30 dias;
- nomes das coleções raiz do Firestore.

## O que ele não faz

- não cria, edita ou remove usuários;
- não grava, edita ou exclui documentos Firestore;
- não altera Rules;
- não muda IAM;
- não faz deploy;
- não compra capacidade.

A leitura de Authentication tem teto de segurança de 10.000 usuários por execução. Se o projeto exceder esse limite, o retorno será marcado como truncado.

# Painel administrativo — Protocolo DELECTUS

Painel privado para acompanhar referências, sessões anônimas e avanço dos participantes no Protocolo DELECTUS.

## Segurança

- O frontend utiliza apenas a chave publicável do Supabase.
- Os dados não podem ser consultados diretamente pelas funções públicas do banco.
- A leitura administrativa passa pela função `admin-dashboard`, que exige autenticação e presença na tabela `admin_users`.
- Nenhuma chave secreta deve ser adicionada a este repositório.

## Publicação

O workflow em `.github/workflows/deploy-pages.yml` publica o conteúdo estático no GitHub Pages a cada atualização da branch `main`.

Ative Pages com origem GitHub Actions. Repositórios privados exigem um plano GitHub compatível. O workflow publica somente os quatro arquivos de interface.

## Estado da integração

Há 20 grupos ativos em português e 63 variantes em latim, armazenados somente no banco. As referências anteriores foram desativadas. O Protocolo ainda não envia sessões ou progresso; a coleta será implementada na integração seguinte. Sessões representam navegadores, não uma contagem exata de pessoas. A mesma referência poderá ter várias sessões independentes.

A integração de acesso deve normalizar a entrada com trim, espaços internos consecutivos para um espaço e lowercase, procurar `protocol_reference_aliases.alias` e verificar `protocol_references.is_active`. Nunca validar pelo nome português do grupo. Não publicar a lista de senhas no repositório.

## Primeiro administrador

Crie o usuário em Supabase → Authentication → Users → Add user, definindo a senha diretamente nessa interface. Depois autorize somente o UUID confirmado desse usuário na tabela `public.admin_users`. Não há cadastro administrativo público. Nunca coloque senhas, tokens ou listas de referências no frontend.

## Backend

`supabase/functions/admin-dashboard/index.ts` contém a função publicada. Ela verifica o token com Auth e exige presença em `admin_users` antes de consultar os dados. As quatro tabelas têm RLS e nenhum acesso direto para anon/authenticated: o aviso informativo de RLS sem políticas é intencional, pois somente o backend pode consultá-las.

O teste de login autorizado depende da criação do primeiro administrador. O painel ainda requer paginação no backend antes de ultrapassar 1.000 sessões.

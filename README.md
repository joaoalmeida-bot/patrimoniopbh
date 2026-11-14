# Patrimonio PBH

Sistema web para controle de patrimônio, empréstimos e devoluções de equipamentos da PBH. O nome foi corrigido para **Patrimonio PBH**.

## Rodar localmente

1. Instale Node.js 20 ou superior.
2. Execute `npm install` e depois `npm start`.
3. Acesse `http://localhost:3000`.
4. Sem `DATABASE_URL`, o app usa uma memória local apenas para demonstração; os dados são perdidos ao reiniciar.

## Supabase

1. Crie um projeto no Supabase.
2. Abra **SQL Editor** e execute `supabase/schema.sql`.
3. Em **Connect**, copie a URI do Postgres Session pooler (porta 5432).
4. No Railway, adicione essa URI como `DATABASE_URL`.
5. Adicione `SESSION_SECRET` com uma chave longa e aleatória.
6. Faça deploy deste diretório. O Railway detecta o `Dockerfile` automaticamente.

## Acesso dos suportes técnicos

Usuários autorizados: `joao.almeida` e `geliane.maria`.

Na tela de login, clique em **Cadastrar / gerar senha**, informe um dos e-mails institucionais autorizados e copie a senha exibida. A senha é aleatória, começa com `pbh` e é armazenada somente como hash.

## Funcionalidades

- Login restrito aos dois usuários aprovados.
- Cadastro de senha por e-mail institucional, sem envio de e-mail externo.
- Cadastro de equipamentos e status disponível/emprestado.
- Empréstimo com telefone opcional e devolução prevista opcional.
- Devolução por código do patrimônio.
- Histórico pesquisável.
- Exportação do histórico em Excel (`.xlsx`).
- Nome do usuário logado preenchido automaticamente em “Autorizado por”.

## Observação de segurança

O app entrega a senha gerada uma única vez na tela para o suporte copiar. Em produção, recomenda-se adicionar envio por e-mail institucional e redefinição de senha em uma próxima etapa.

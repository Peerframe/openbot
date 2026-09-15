<p align="center">
  <img src="docs/design/openbot-readme-banner.png" alt="OpenBot" width="100%">
</p>

# OpenBot

**Um espaço de trabalho auto-hospedado para trabalhadores digitais, pelo Desktop e pela Web.**

[English](README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [Português (Brasil)](README.pt-BR.md)

[![CI](https://github.com/Peerframe/openbot/actions/workflows/ci.yml/badge.svg)](https://github.com/Peerframe/openbot/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-2563eb.svg)](LICENSE)

O OpenBot organiza funcionários de IA nos computadores que você controla. Canais, conversas,
perfis, tarefas, aprovações e resultados ficam no seu espaço de trabalho. Desktop e Web compartilham
a interface React e se conectam ao mesmo OpenBot Server.

Um único Desktop pode combinar os papéis Client, Server e Worker conforme cada plataforma for
implementada. Client permite orientar e supervisionar; Worker e Providers executam no computador
registrado; somente Server controla identidade, roteamento, autorização e auditoria.
Exibir uma área de trabalho não concede permissão para controlá-la.

> [!WARNING]
> O OpenBot está em pre-alpha. Os pacotes Desktop são bundles de desenvolvimento sem assinatura,
> não instaladores públicos assinados. O Provider atual apenas abre uma URL pública explícita e
> retorna uma captura de tela. Cliques arbitrários, digitação e envio autônomo de formulários não
> estão implementados. Não conecte meios de pagamento, contas principais nem credenciais de produção.

## Desktop para Windows, macOS e Linux

As três plataformas usam Electron 44.2.0 e a mesma interface de canais.

| Destino | Cliente Desktop | Server local | Worker local |
| --- | --- | --- | --- |
| macOS arm64 | Conexão com Server existente, navegação nativa e interface compartilhada | PostgreSQL e Server incluídos, sem Docker | Pareamento guiado pelo macOS Worker companion incluído no bundle |
| Windows x64 | Conexão com Server existente e interface compartilhada | Server implantado separadamente | Windows Host com evidência de build/contratos; instalação integrada ao Desktop planejada |
| Linux x64 | Conexão com Server existente e interface compartilhada | Server implantado separadamente | Node/serviço implantado separadamente; integração ao Desktop planejada |

A matriz de CI compila e empacota esses destinos. São evidências de desenvolvimento, não certificação
de controle de desktops reais. macOS Intel e outras arquiteturas ficam fora dessa matriz.
A inicialização dos serviços locais tem evidência em macOS arm64; Windows e Linux começam pela conexão remota.

### Baixar um bundle de desenvolvimento

**[Downloads e instalação do Desktop (em inglês)](docs/DESKTOP_INSTALLATION.md)** reúne os nomes
dos arquivos, comandos de instalação e a primeira configuração do modelo. O CI nativo gera DMG
(macOS arm64), EXE por usuário (Windows x64) e AppImage/DEB (Linux x64). Até que uma versão
`desktop-v...` com anexos seja publicada em [Releases](https://github.com/Peerframe/openbot/releases),
use os artefatos de instaladores de um CI bem-sucedido: exigem login e são retidos por 14 dias.
A publicação ainda está pendente.

Abra uma execução bem-sucedida do commit desejado em
[GitHub Actions](https://github.com/Peerframe/openbot/actions/workflows/ci.yml) e baixe
`openbot-desktop-<platform>-<arch>-<commit>.tar.gz`. É necessário entrar no GitHub; os artefatos
expiram em sete dias. Extraia com `tar -xzf <archive>` para preservar permissões e links simbólicos.
Abra `OpenBot.app` no macOS, `openbot.exe` no Windows ou `openbot` no Linux.
Continuam valendo os requisitos do sistema para aplicativos sem assinatura.

Cada destino envia seu bundle apenas após passar nas verificações. Os arquivos tar são diretórios
de aplicação; os artefatos separados `openbot-installers-...` contêm instaladores e checksums.
Não há canal de atualização automática.
A Release antiga `v0.1.0-alpha.1` continua sendo um snapshot da fundação contendo apenas código-fonte.

### Compilar a partir do código-fonte

Use Node.js 24 LTS dentro do [intervalo declarado](package.json) e npm no sistema de destino:

```bash
git clone https://github.com/Peerframe/openbot.git
cd openbot
npm ci
npm run check
npm run package --workspace @openbot/desktop
```

A saída fica em `apps/desktop/out/`. O macOS inclui Server local e PostgreSQL na versão fixada.
O build comum não inclui o Worker companion, a menos que
`OPENBOT_DESKTOP_MACOS_WORKER_COMPANION` aponte para um bundle validado; o CI macOS o compila antes.
No macOS, escolha criar os serviços locais ou conectar a outro Server. Windows e Linux oferecem
a conexão a um Server HTTPS confiável com login de Owner.
Veja o fluxo e o ciclo dos dados em [Desktop setup](docs/DESKTOP_ONBOARDING.md).

## Estado do projeto

| Área | Implementado no código | Próximos passos |
| --- | --- | --- |
| Desktop / Web | Canais, Bots, aprovações, inspetor, voltar/avançar, menus nativos, restauração de rascunhos e rolagem, galeria de skills e preferências persistentes | Notificações, localização e evidência adicional de acessibilidade/dispositivos |
| Serviços macOS | PostgreSQL/Server próprios do app, bootstrap criptografado, reinício preservando dados e troca para cliente remoto | Outros sistemas, compartilhamento remoto autenticado, backup, upgrades e serviço de login |
| Modelos / Agent nativo | Ativação explícita pelo Owner, configuração criptografada, ciclo modelo/ferramenta/observação, leituras do canal e URLs explícitas, relatórios Markdown, interrupção/reenvio e uso registrado do modelo | Evidência com modelos reais, mais ferramentas controladas e adaptadores externos |
| Tarefas automáticas | Persistência PostgreSQL, pausar/retomar/excluir, intervalos limitados, no máximo uma ocorrência após indisponibilidade e roteamento autorizado existente | Coordenação entre Servers e outras formas de agendamento |
| Funcionários | Perfil, evolução datada, revisão de skills, memória gerida pelo Owner, propostas revisadas com compartilhamento explícito com o modelo, importação/exportação vinculada à revisão e assinatura DSSE experimental | Aprendizado autônomo, skills executáveis, clonagem seletiva e confiança pública |
| Worker | Conexões de saída, pareamento único, revogação, capacidades versionadas, progresso, imagens e artefatos | Prova de posse, conformidade completa em dispositivos e distribuição assinada |
| Execução | Captura de URL pelo Docker/browser, somente leitura | Interação segura, Providers nativos, leases assinados de uso único e tomada de controle exclusiva |

O [Agent nativo](docs/NATIVE_AGENT.md) executa novas tarefas de perfil `none` após ativação explícita.
Ainda não há adaptadores Hermes/Pi/OpenClaw, ciclo de
instalação de plugins ou controle arbitrário do desktop. Cua, Lume e coder são fronteiras de extensão;
a visualização de escritório continua adiada.
A evolução e o aprendizado dos funcionários são explicitamente inspirados no
[learning graph do Hermes Agent](https://github.com/NousResearch/hermes-agent/blob/63279301bcbdc185c1b07b98a9312eb0c862f26d/agent/learning_graph.py).
O OpenBot tem seu próprio modelo de evidência, revisão e portabilidade, sem reivindicar a invenção do conceito.

## Desenvolvimento e implantação separada

Desktop é opcional. Para executar Server, PostgreSQL e Web separadamente:

```bash
cp .env.example .env
# Defina OPENBOT_OWNER_PASSWORD com uma senha aleatória de pelo menos 15 caracteres.
npm ci
npm run db:up
npm run dev:server
# Em outro terminal:
npm run dev:web
```

Abra <http://localhost:5173>, crie Bot e canal e use Nodes para parear um Worker.
`npm run node:enrollment-token -- local-development-node` também emite um token de uso único.
Siga [Node enrollment](docs/NODE_ENROLLMENT.md) para iniciar `npm run dev:node` e remova o token
após o registro. Sem Provider, as tarefas continuam na fila. Pare PostgreSQL com `npm run db:stop`.

Para o fluxo de navegador, execute o
[agent-computer fixado](https://github.com/CopilotKit/openbot/tree/257c1280d684089be9adb0b35cce262efc7064bf/agent-computer)
no loopback do Node e configure `OPENBOT_DOCKER_COMPUTER_URL`, `OPENBOT_DOCKER_COMPUTER_TOKEN`
e `OPENBOT_DOCKER_ALLOW_PRIVATE_HOSTS=false`. Envie uma URL pública explícita no canal.
Veja [Server container](docs/SERVER_CONTAINER.md) e [Automations](docs/AUTOMATIONS.md).
Agendamentos exigem Server ativo e não acrescentam permissões nem um motor de inferência.

## Segurança e arquitetura

Desktop/Web → Server → Worker autorizado → Providers. Server é a única fonte de verdade.
Renderizadores, modelos, páginas, skills, Workers e Providers não são confiáveis.
Efeitos colaterais sensíveis exigem política e aprovação explícitas. Desktop usa recursos locais,
sandbox, IPC tipado e fuses verificados.

Uso remoto exige HTTPS, `OPENBOT_SECURE_COOKIES=true`, `OPENBOT_ALLOWED_ORIGINS` restrito e rede
privada confiável. Mantenha bancos e backends de execução privados. Credenciais Node ainda são
bearer secrets; pareamento não significa prova de posse ou mTLS.
Veja [Security](SECURITY.md), [modelo de ameaças](docs/SECURITY.md) e
[Provider conformance](docs/PROVIDER_CONFORMANCE.md).

## Contribuição e documentação

Use branch de funcionalidade e PR. Pesquise e fixe versões antes de mudar comportamentos, preserve
avisos de licença e traduções, e execute `npm run check` e `npm audit`.
Leia [Contributing](CONTRIBUTING.md) e [reutilização de código aberto](docs/OPEN_SOURCE_REUSE.md).

| Caminho | Responsabilidade |
| --- | --- |
| `apps/desktop`, `apps/web` | Shell Electron e interface React |
| `apps/server`, `apps/node` | Plano de controle e daemon de execução |
| `apps/worker-host-macos`, `apps/worker-host-windows` | Integração nativa de serviços |
| `packages/*`, `providers/*` | Domínio, protocolo, armazenamento, política e adaptadores |
| `deploy/`, `docs/` | Implantação, contratos, pesquisa e evidências |

Comece por [Product](docs/PRODUCT.md), [Architecture](docs/ARCHITECTURE.md),
[Roadmap](docs/ROADMAP.md), [API](docs/API.md), [Cross-platform](docs/CROSS_PLATFORM.md),
[Database](docs/DATABASE.md) e [Employee signing](docs/EMPLOYEE_SIGNING.md).

## Licença e nome

[MIT](LICENSE). Avisos de terceiros estão em [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
OpenBot é um nome provisório já usado por projetos como CopilotKit/OpenBot; um nome distinto deve
ser escolhido antes da versão estável. Não há afiliação com xAI, Tencent, CopilotKit, OpenClaw ou
outros projetos mencionados.

# gpt-worker

**開発中・実験的プロジェクトです。使用にあたっては自己責任でお願いします。**

**ChatGPT Web のテキストをAIエージェントにコピペするのをやめよう**

Codex, Claude Code, Antigravity などの AI エージェントに「gpt-workerで計画して」「gpt-workerでレビューして」と依頼すると、Web 版 ChatGPT が開いて、調査タスクが自動実行されます。エージェントに結果が届きしだい、実装を開始します。gpt-worker はメッセージハブとして機能します。

![gpt-worker](images/gpt-worker_lead.png)

**gpt-worker** は、エージェントの5h / 週ごとの利用制限を軽減するため、Web ブラウザ版の ChatGPT を「計画・レビュー役」として使い、手元のローカルエージェント（Claude Code、Antigravity、Codex など）やあなた自身が「実行役（手足）」としてコードを編集・テストする開発支援ツールです。

利用できる ChatGPT は、Plus、Business、Pro など、Projects・Developer mode・カスタム MCP コネクタが利用可能なプランです。

このツールは、[XiaoDuoYa/codex-with-chatgpt](https://github.com/XiaoDuoYa/codex-with-chatgpt) に着想を得ています。ChatGPT Web とローカルブリッジとの連携を Cloudflare Workers上のメッセージハブを介した形で実現し、ターゲットを macOS、Google Chrome に限定することでコンパクトにしています。
素晴らしいアイデアを提供してくださった XiaoDuoYa さんに感謝いたします。

```text
[ChatGPT Project] ⇄ (MCP / HTTPS) ⇄ [Cloudflare Worker (中継ハブ)] ⇄ (WebSocket) ⇄ [ローカル環境 (bridge)]
```

---

## 主な特長

- **Web サブスクリプションの有効活用**：すでにお持ちの ChatGPT 月額プラン（Plus、Business、Pro など）を利用するため、Codex の 5h / 週ごとの利用制限を軽減しながら開発を進められます。
- **1回設定するだけの共通ハブ**：中継用の Cloudflare Worker と ChatGPT 側の設定は最初の1度だけです。2つ目以降のプロジェクトはローカルコマンド1つで瞬時に追加できます。
- **安全な読み取り専用設計（ワークスペース）**：ChatGPT はリポジトリの調査と計画立案（読み取り専用）のみを行い、ファイルの編集やコマンド実行は行えません。コードの修正やテストの実行は必ずローカル側で検証しながら進められます。
- **機密情報の自動保護**：`.env`、秘密鍵、`.ssh`、`.aws` などの機密ファイルや、Git で無視されているファイルは自動的に ChatGPT から隠されます。さらに、すべてのツール結果は外部の秘密スキャナ（betterleaks/gitleaks）で検査され、検出された秘密情報はその場でマスクされてから ChatGPT に届きます。
- **プロジェクト全体のスナップショット**：ChatGPT は、プロジェクトの読み取り可能なテキストファイルを 1 つのアーカイブ（`workspace_bundle`）として受け取れます。1 ファイルずつ読む必要がなくなります。読み取りのルールは他の操作と同じで、梱包する前に秘密スキャンも行われます。[プロジェクト全体を一度に ChatGPT に渡したい](#プロジェクト全体を一度に-chatgpt-に渡したいworkspace_bundle)を参照してください。
- **Chrome による自動入力と送信**：タスク発行時に Chrome で該当プロジェクトを開き、バックグラウンド（画面フォーカスを奪わずに）でメッセージの入力や送信まで行えます。
- **Web ダッシュボード**：Worker がブラウザ用のダッシュボードを提供します。ワークスペース単体または登録済み全プロジェクトを一覧でき、タスク履歴やキューの確認、ルールの編集、ブラウザからの新規タスク投入などが可能です。[Web ダッシュボード](#web-ダッシュボード)を参照してください。
- **外部 npm パッケージ不要**：Node.js の標準機能だけで構築されているため、追加の npm パッケージのインストールや管理は不要です（安全のため、秘密情報スキャナの betterleaks または gitleaks のみ別途必要です）。

---

## 前提条件

- **OS**：macOS（Chrome 自動連携機能を使用する場合）
- **Node.js**：v22 以上（未導入の場合は `brew install node`）
- **Git**：必須。検査ツールがリポジトリの状態を Git 経由で読み取ります。ローカルブリッジは、Git-ignore されていないと確認できないファイルの読み取りを拒否するため、`git` が無い、または Git がリポジトリを開けないワークスペースは読み取れません。
- **Google Chrome**：ChatGPT を操作するブラウザ
- **ChatGPT アカウント**：Plus、Business、Pro のいずれか（Projects、Developer mode、カスタム MCP コネクタが利用可能なプラン。作者環境の Plus にて動作確認済み）
- **Cloudflare アカウント**：無料プランで十分です（中継 Worker の設置に使用）
- **秘密スキャナ**：[betterleaks](https://github.com/betterleaks/betterleaks)（推奨）または互換フォールバックの [gitleaks](https://github.com/gitleaks/gitleaks) — ローカルブリッジが ChatGPT に届ける前に秘密情報をマスクするために必須です。導入されていないと `gpt-worker start` は起動を拒否します。
  ```bash
  brew install betterleaks   # または: brew install gitleaks
  ```

---

## 初期セットアップ（初回のみ）

セットアップは以下の 5 ステップです。一度完了すれば、他のプロジェクトでも同じ設定をそのまま使い回せます。

### ステップ 1：リポジトリのクローンとコマンドの配置

1. 任意の作業ディレクトリにリポジトリをクローンします。
   ```bash
   git clone https://github.com/Nihondo/gpt-worker.git
   cd gpt-worker
   ```

2. ターミナルから `gpt-worker` コマンドを実行できるように、パスの通った場所へシンボリックリンクを作成します。
   ```bash
   # Homebrew の bin ディレクトリ（Apple Silicon なら /opt/homebrew/bin）に作成する場合：
   ln -s "$(pwd)/bin/gpt-worker" "$(brew --prefix)/bin/gpt-worker"
   ```
   > **ヒント**：Apple Silicon Mac の場合は直接 `/opt/homebrew/bin/gpt-worker` にリンクを作成しても構いません（Intel Mac の場合は `/usr/local/bin`）。`$(brew --prefix)/bin` を使うと環境に合わせて自動解決されます。`~/.local/bin` などお好みの PATH 配下でも構いません。

### ステップ 2：エージェントへのスキル登録（SKILL.md）

お使いのコーディングエージェントの skills ディレクトリへ `SKILL.md` のシンボリックリンクを作成し、エージェントが `gpt-worker` を認識できるようにします。

```bash
# 例：Claude Code の場合
mkdir -p ~/.claude/skills/gpt-worker
ln -s "$(pwd)/SKILL.md" ~/.claude/skills/gpt-worker/SKILL.md

# 例：Codex の場合
mkdir -p ~/.codex/skills/gpt-worker
ln -s "$(pwd)/SKILL.md" ~/.codex/skills/gpt-worker/SKILL.md

# 例：Antigravity の場合
mkdir -p ~/.agents/skills/gpt-worker
ln -s "$(pwd)/SKILL.md" ~/.agents/skills/gpt-worker/SKILL.md
```

> **【任意】サブエージェントとして実行したい場合（Claude Code / Codex CLI）:**  
> 通常のスキルとして呼び出すと、現在の対話セッションの中で ChatGPT の返信待ち（最大15分）が発生し、途中のログもチャット履歴（コンテキスト）にたまっていきます。  
> Claude Code や Codex CLI では、この一連の作業ループをバックグラウンドの「サブエージェント」に任せることができます。**待ち時間中もメインの会話を続けたい場合**や、**中間のやり取りでチャット履歴を圧迫したくない場合**は、以下のエージェント設定も併せてリンクしてください。
> ```bash
> # Claude Code の場合
> mkdir -p ~/.claude/agents
> ln -s "$(pwd)/.claude/agents/gpt-worker.md" ~/.claude/agents/gpt-worker.md
>
> # Codex CLI の場合
> mkdir -p ~/.codex/agents
> ln -s "$(pwd)/.codex/agents/gpt-worker.toml" ~/.codex/agents/gpt-worker.toml
> ```
> 設定後は、チャットで「gpt-worker エージェントで実行して」と指示するだけでサブエージェントとして呼び出せます（※ Codex のカスタムエージェント機能は現在仕様変更が多いため、お使いのバージョンで読み込めない場合は通常のスキルをご利用ください）。

### ステップ 3：初期化と Worker の準備

最初のプロジェクトのディレクトリを指定して `init` コマンドを実行します。

```bash
gpt-worker init -w /path/to/your-project
```

- 初回実行時のみ、ブラウザで Cloudflare へのログイン画面が開きます。
- ログインが完了すると、自動的に Cloudflare Worker がデプロイされます。
- 完了時に表示される `Server URL` を確認します（後から `gpt-worker url` でも確認できます）。

### ステップ 4：ChatGPT の設定

1. **開発者モードを有効にする**：
   - ChatGPT の **設定** → **Apps** / **Developer mode**（UI のバージョンやアカウント種別により設定内の配置が異なる場合があります）を開き、Developer mode をオンにします。
2. **MCP Connector を登録する**：
   - **設定** → **Connectors**（または **Apps** / Developer mode 設定）から新しいコネクタを追加します。
   - **Name**：`gpt-worker`（固定。変更不可）
   - **Server URL**：`gpt-worker url` で表示された URL
   - **Authentication**：`OAuth` を選択します。同意画面が開いたら、`gpt-worker url` で表示されたトークンを入力して承認します。
   - **コネクタ URL を選ぶ**：
     - **共有コネクタ（推奨）**：`gpt-worker url` は `/mcp` を表示します。登録済みのすべてのワークスペースを 1 つのコネクタで使用できます。ChatGPT は `list_workspaces` でワークスペースを選び、以降のツール呼び出しに `workspace_id` を指定します。
     - **プロジェクト専用コネクタ**：`gpt-worker url -w /path/to/your-project` は `/mcp/<workspace_id>` を表示します。1 つのワークスペースだけにアクセスを限定したい場合は、別のコネクタとして登録します。このコネクタには `list_workspaces` はなく、ツール呼び出しに `workspace_id` を指定する必要もありません。
3. **ChatGPT Project を作成する**：
   - ChatGPT の左サイドバーから **New Project** を作成します（例：`Coding Assistant`）。
   - プロジェクト設定で **Project-only memory** を有効にすることをお勧めします。
4. **指示文（Project Instructions）を設定する**：
   - 作成したプロジェクトの **Instructions** 欄に、以下の 1 行の英語テキストをそのまま貼り付けて保存します。
     ```text
     Use the gpt-worker connector. It supplies its own operating instructions — follow them for every round.
     ```
   - 詳細な運用手順はコネクタ経由で ChatGPT に自動提供されるため、他に指示文を貼り付ける必要はありません。gpt-worker をアップデートしても貼り直す必要はありません。
   - ※ 欄を空のままにしても動作しますが、上記の 1 行を記載しておくと新しい会話スレッドの初回応答がより確実になります。
   - プロトコル本文そのものは [worker/src/instructions.md](worker/src/instructions.md) にあります。

### ステップ 5：ChatGPT Project URL の登録と Chrome の自動送信設定

1. 作成した ChatGPT Project の URL（ブラウザのアドレスバーにある `https://chatgpt.com/g/...`）を CLI に登録します。
   ```bash
   gpt-worker chat-url "https://chatgpt.com/g/g-p-.../project"
   ```
   登録すると、タスク発行時に Chrome がプロンプトを準備し、Apple Events が有効なら自動送信します。

2. **Chrome の自動送信を許可する（初回のみ）**：
   画面フォーカスを奪わずにバックグラウンドでメッセージを入力・送信させるために、Chrome 側で以下の設定を有効にします。
   - Chrome のメニューバーから **表示** → **開発** → **Apple EventsからのJavaScriptを許可** にチェックを入れる。
   - 設定後、**Chrome を完全に再起動** する（`Cmd + Q` で終了してから開き直す）。
   > **注意**：この設定が無効のままだと、プロンプトが入力欄にセットされた状態で停止し、手動で Enter キーを押して送信する必要があります。

---

## 基本的な使い方（日常の作業サイクル）

> **💡 普段の作業はエージェントへの指示だけで完了します**  
> スキル（`SKILL.md`）を登録していれば、お使いのエージェント（Claude Code、Codex、Antigravity など）に対して「**gpt-worker で計画して**」「**ChatGPT でレビューさせながら進めて**」と伝えるだけで、以下のサイクルを自律的に進め、各ステップの CLI コマンドを実行します。  
> そのため、**多くの場合ユーザー自身が直接コマンドを叩く必要はありません**。  
> （手動で直接コマンドを実行したい場合や動作状況を確認したい場合も、以下の手順をそのまま利用できます。Claude Code または Codex CLI では「gpt-worker エージェントで実行して」と頼むと、同じループをサブエージェントとして実行できます——[ステップ 2](#ステップ-2エージェントへのスキル登録skillmd) を参照。）

開発作業は、内部的には **「依頼 (task) → 待機 (wait) → 実装・テスト → 報告 (report) → レビュー待機 (wait)」** のサイクルで進みます。

```text
[あなた / ローカルエージェント]                 [ChatGPT]
          │                                         │
          │── 1. gpt-worker task "<作業内容>" ────>│
          │                                         │ (コード調査 & 計画立案)
          │<── 2. gpt-worker wait (計画受信) ───────│
          │                                         │
     (コード修正 & テスト実行)                      │
          │                                         │
          │── 3. gpt-worker report ────────────────>│
          │                                         │ (変更差分の確認 & レビュー)
          │<── 4. gpt-worker wait (完了または指示) ─│
```

### 1. 通信ブリッジを起動する
作業を始める前に、対象プロジェクトでローカル通信プロセス（ブリッジ）を起動します。

```bash
gpt-worker start -w .
gpt-worker status -w .
```
> 💬 *通常はこれを明示的に伝える必要はありません。gpt-worker に何か頼んだ瞬間、エージェントが自分でブリッジの状態を確認・起動します。*

### 2. タスクを依頼する（`task`）
やりたい作業内容を自然言語で伝えます。

```bash
gpt-worker task "ログイン画面のバリデーション表示を修正して" -w .
```
> 💬 **チャットでは:** 「gpt-worker で計画して：ログイン画面のバリデーション表示を修正して」

Chrome で ChatGPT の画面が開き、プロンプトが自動で入力・送信されます（※ 自動送信には上述の Chrome「Apple EventsからのJavaScriptを許可」設定が必要です）。

### 3. 計画の完成を待つ（`wait`）
ChatGPT がファイルを調査し、作業計画（PLAN）を作成するのを待ちます。

```bash
gpt-worker wait -w .
```
> 💬 *上記の依頼の直後に自動で実行されます。別途伝える必要はありません（中断したセッションを再開する場合は [待ち時間がタイムアウトしたとき](#待ち時間がタイムアウトしたとき) を参照）。*

計画が届くとターミナルに出力されます。内容を確認し、問題がないかチェックします。

### 4. コード修正とテストを実行する
ローカルエージェント（Claude Code や Antigravity など）またはあなた自身が、計画に沿ってファイルを編集し、テストを実行します。

### 5. 結果を報告する（`report`）
変更したファイル数やテスト結果を ChatGPT に報告します。

```bash
gpt-worker report --changed 2 --tests "8 件のテストすべて合格" -w .
```
> 💬 **チャットでは:** 「変更内容を ChatGPT に報告してレビューしてもらって」

### 6. レビュー結果を受け取る（`wait`）
再度 `wait` を実行して ChatGPT の返答を待ちます。

```bash
gpt-worker wait -w .
```
> 💬 *ステップ3と同様、自動で実行されます。*

ChatGPT が「完了（DONE）」と判断すれば作業終了です。追加の作業指示がある場合は、ステップ 4 へ戻ります。

### 7. 作業を終了する
作業が終わったらブリッジプロセスを停止します。

```bash
gpt-worker stop -w .
```
> 💬 *タスク実行中以外は、外部からの問い合わせを遮断します。放置しても問題ありません。*

---

## よくある操作・逆引きガイド

### 新しいチャットの開始と会話スレッドの管理
gpt-worker はワークスペースごとに ChatGPT の会話スレッド（URL）を記憶し、同じスレッド上で対話を継続します。  
会話が長くなって ChatGPT の動作が重くなった場合や、新しいスレッドで仕切り直したい場合、あるいはブラウザで手動で開いた別の会話に切り替えたい場合は、以下のコマンドを使用します。

```bash
# 同じ Project 内で、次回から新しい会話スレッドを開始する
gpt-worker chat new -w .

# ブラウザで手動で開いた特定の会話スレッド（URL）に紐付ける
gpt-worker chat attach "https://chatgpt.com/g/g-p-.../c/..." -w .

# 現在紐付いている Project URL と会話スレッドを確認する
gpt-worker chat status -w .
```
> 💬 **チャットでは:** 「このプロジェクト用に新しい ChatGPT の会話を始めて」／「このプロジェクトを &lt;url&gt; の ChatGPT 会話に紐付けて」／「このプロジェクトはどの ChatGPT 会話に紐付いている？」

### 別のプロジェクトを追加したい
Cloudflare Worker の再デプロイや ChatGPT の再設定は不要です。新しいディレクトリで `init` を実行するだけで登録できます。

```bash
gpt-worker init -w /path/to/another-project
```
> 💬 **チャットでは:** 「このプロジェクトにも gpt-worker をセットアップして」

### プロジェクト固有のルールを設定したい（`guidance`）
「テストは Vitest で書く」「TypeScript の strict モードを守る」など、ChatGPT に常に守らせたい前提ルールを登録できます。

```bash
# ルールを登録
gpt-worker guidance "テストは必ず Vitest で書き、関数コンポーネントを優先すること" -w .

# 登録中のルールを確認
gpt-worker guidance -w .

# ルールを解除
gpt-worker guidance --clear -w .
```
> 💬 **チャットでは:** 「このプロジェクトの gpt-worker のガイダンスを設定して：テストは必ず Vitest で書き、関数コンポーネントを優先すること」／「このプロジェクトの gpt-worker のガイダンスを解除して」

### 読み取りアクセスの管理（allow-read と deny-read）
`.gitignore` に含まれるファイルは通常 ChatGPT から隠され、通常の追跡ファイルは読み取ることができます。`allow-read` と `deny-read` を使用して、きめ細かな読み取りポリシーを設定できます。

- **ポリシーの優先順位**: 機密ファイル（`.env`、秘密鍵など） > `deny-read` > `.gitignore` ベースライン（`allow-read` による例外許可を含む）。機密パスは絶対に読み取れません。
- **`allow-read <path>`**: Git で無視されているファイルまたはディレクトリへの MCP `read_file` 直接読み取りを個別許可します。ディレクトリ配下のファイルは一覧表示や検索からは隠蔽されたままとなります。
- **`unallow-read <path>`**: `allow-read` の例外許可を解除します。
- **`deny-read <path>`**: ファイルまたはディレクトリ（通常の追跡ファイルや過去に allow-read されたパスを含む）の読み取りを明示的に禁止します。禁止されたパスは一覧表示、検索、直接読み取りから完全に隠蔽されます。
- **`undeny-read <path>`**: 明示的な禁止設定を解除します。そのパスが同時に allow-read にも登録されていた場合、背後にある allow-read 例外が再び有効になります。

```bash
# Git で無視されているファイルまたはディレクトリの読み取りを許可
gpt-worker allow-read config/test-fixture.json -w .
gpt-worker allow-read fixtures -w .

# 許可中のパス一覧を確認
gpt-worker allow-list -w .

# allow-read の例外を解除
gpt-worker unallow-read config/test-fixture.json -w .
gpt-worker unallow-read fixtures -w .

# 通常ファイルや許可済みパスの読み取りを明示的に禁止
gpt-worker deny-read secret-docs -w .
gpt-worker deny-read config/internal.json -w .

# 禁止中のパス一覧を確認
gpt-worker deny-list -w .

# 明示的な禁止設定を解除
gpt-worker undeny-read secret-docs -w .
gpt-worker undeny-read config/internal.json -w .
```
※ `gpt-worker status` では `read allowed` と `read denied` の両方のパスが表示されます。`.env` や秘密鍵（`.ssh/` 等）などの機密ファイルは、いずれのリストによっても読み取り可能になることはありません。

> [!NOTE]
> **互換性に関する注意**: 従来の `gpt-worker` では、`deny-read` は `allow-read` の例外許可を取り消すために使用されていました。その操作は `unallow-read` に変更されました。現在の `deny-read` は、通常の追跡ファイルや許可済みパスを含む任意のパスを対象に、独立した永続的拒否ルールを作成します。既存の `read-allowlist.json` のエントリはそのまま保持されます。

### プロジェクト全体を一度に ChatGPT に渡したい（`workspace_bundle`）
ChatGPT は `workspace_bundle` を呼び出すことで、プロジェクトの読み取り可能なテキストファイルを 1 つの `.tgz` アーカイブとして受け取り、自身のサンドボックスで展開して必要な箇所だけ読めます。広い文脈が必要な作業で、何度もファイルを読みに行く往復を減らせます。ご自身で実行するものではなく、ChatGPT が必要なときに呼び出します。

- **他の読み取りと同じルール**：ChatGPT がすでに読める範囲だけが入ります。機密ファイル（`.env`、秘密鍵など）、Git で無視されているファイル、`deny-read` したパス、ノイズの多いフォルダ（`node_modules`、ビルド出力など）は除外され、名前も件数も出ません。`allow-read` したパスは直接読み取り専用のままで、アーカイブには**入りません**。
- **梱包前に秘密をマスク**：スキャナが見つけた秘密はすべて `[REDACTED:<ルール名>]` に置き換えられ、ローカルのパスは `[workspace]` や `[home]` に正規化されます。その場でマスクできない秘密が見つかったファイルは、代わりにアーカイブから外されます。
- **入らないもの**：バイナリファイル、シンボリックリンク、1 MiB を超えるファイル。アーカイブの先頭にある `BUNDLE.md` に、これらの一覧と、アーカイブが完全かどうかが書かれます。
- **サイズ**：既定は 1 MiB、最大 4 MiB です。大きすぎる場合、ChatGPT にはフォルダ別の内訳付きのエラーが返り、より狭い `path` を指定し直します。黙って切り詰められることはありません。
- **アーカイブを開く際に ChatGPT が承認を求めます。** 初回は「ファイルを実体化しますか？」というダイアログが出ます。**「この会話内では許可」**（「許可する」の右の矢印から選択）を選ぶと、その会話では再度聞かれません。通常の「許可する」だと毎回聞かれます。新しい会話では再び聞かれます。
  - **拒否**すると、ChatGPT には拒否されたことが伝わり、アーカイブの再試行はしません。1 ファイルずつ読むように依頼してください。
  - 誰も応答しないと、ChatGPT は**無期限に待ち続け**ます（15 分以上待っても続くことを確認済み）。gpt-worker はダイアログ自体は見えませんが、「アーカイブを渡したあと ChatGPT が静かになった」ことは分かります。その場合、`gpt-worker wait` が通知を出し、沈黙が続くと催促を出します。`gpt-worker status` にも `hint` の行が出ます。未回答のダイアログと、ChatGPT がアーカイブをまだ読んでいる状態は区別できないため、証拠ではなく、ChatGPT の画面を見るきっかけとして扱ってください。
- `tar` が必要です（macOS と Linux には標準で入っています）。

### 設定内容を確認したい
登録されている Project URL や自動送信の設定を確認できます。

```bash
gpt-worker show-config -w .
```
> 💬 **チャットでは:** 「このプロジェクトに設定されている ChatGPT のブラウザ設定を確認して」

### 登録中のワークスペース一覧を見たい
このマシンで登録されている全プロジェクトと、ブリッジの稼働状態を一覧表示します。

```bash
gpt-worker workspaces
```

### Web ダッシュボード

![gpt-worker Web Dashboard](images/gptworker_webui.png)

Cloudflare Worker はブラウザダッシュボードも配信します。キュー状態・タスク履歴をカンバン風に可視化し、メッセージの ack/discard、guidance/limits の編集、CLI を使わずブラウザから新規タスクを投入することもできます。ログイン経路は2つあり、それぞれ URL が異なります。

**ワークスペース単位**（そのワークスペース自身の owner token でログイン）:

```bash
gpt-worker url -w .
# WebUI URL:         https://<your-worker>.workers.dev/dashboard/<workspace_id>
# OAuth Server URL:  https://<your-worker>.workers.dev/mcp/<workspace_id>
# OAuth owner token: <gpt_token>
```

`WebUI URL`（`https://<your-worker>.workers.dev/dashboard/<workspace_id>`）を開き、上記と同じ owner token（そのワークスペースの `gpt_token`）でログインします。**共有 hub token ではここではログインできません**（拒否されます）。ログインすると、その owner token は 24 時間有効なブラウザセッション（そのワークスペースのダッシュボード専用パスに限定された `HttpOnly`/`Secure` Cookie）と交換されます——以降のリクエストで owner token 自体が再送されることはありません。

**登録済み全ワークスペースの横断**（共有 hub token でログイン）:

```bash
gpt-worker url
# WebUI URL:         https://<your-worker>.workers.dev/dashboard/hub
# OAuth Server URL:  https://<your-worker>.workers.dev/mcp
# OAuth owner token: <hub_gpt_token>
```

`WebUI URL`（`https://<your-worker>.workers.dev/dashboard/hub`）を開き、その共有 hub token でログインします（**単一ワークスペースの `gpt_token` ではここではログインできません**）。ログイン後は、この共有コネクタに登録されている全ワークスペース（`gpt-worker init` で追加され、ChatGPT の `list_workspaces` にも表示されるのと同じ一覧）を選択できるワークスペース一覧が表示され、選んだワークスペースについて単一ワークスペース用ダッシュボードと全く同じ閲覧・操作ができます。2つのログインは完全に別セッションです——ワークスペースのセッションで hub ダッシュボードに入ることはできず、hub のセッションでワークスペース自身のダッシュボード URL に直接ログインすることもできません。また hub 側は自身が登録済みのワークスペースにしか到達できず、任意のワークスペースには到達できません。

できること・動作仕様:
- **できること**: キューに残っているメッセージやタスク履歴の閲覧（時系列タイムライン表示含む）、メッセージの確認（ack）や破棄（discard）、guidance（開発ルール）やメッセージ上限サイズの編集、ブラウザ設定（共有 Project URL・個別 override・会話 URL）の確認・編集・クリア、ブラウザからの新規タスク投入（これらはワークスペース単位・hub 横断のどちらのダッシュボードからも操作可能です）。
- **MCP アクセス履歴**: タスク・メッセージタブの隣にある **MCP Access** タブで、ChatGPT が MCP コネクタ経由で行った操作を確認できます（下記の [MCP アクセス履歴](#mcp-アクセス履歴) を参照）。
- **リアルタイム更新**: WebSocket によるリアルタイムプッシュ通知に対応しており、タスクの進捗やメッセージの送受信、設定変更などが画面へ即座に反映されます（WebSocket 切断時は適応型ポーリング（作業中: 約30秒、アイドル: 約2分、Hub ワークスペース一覧: 約60秒）へ自動フォールバックし、タブ非表示時は通信を停止します）。
- **データ保持期間**: Worker 本体の仕様に準拠します（acked メッセージは7日後、完了したタスク履歴は30日後に自動消去）。MCP アクセス履歴は24時間、1ワークスペースあたり最大1000件まで保持されます。

ワークスペース単位のダッシュボードは、そのワークスペースの owner token をローテーションした場合（`gpt-worker rotate --gpt -w .`）、またはワークスペースを削除した場合（`gpt-worker remove -w . --yes`）にセッションが即座に無効化されます。hub ダッシュボードは、共有 hub token をローテーションした場合（`gpt-worker rotate --hub`）にセッションが即座に無効化されます——[データの保持期間](#データの保持期間)を参照してください。

#### MCP アクセス履歴

**MCP Access** タブには、ChatGPT がコネクタ経由で行ったツール呼び出しが新しい順に一覧表示されます。何を読んだか（読もうとしたか）、なぜ拒否されたかを確認できます。各行には次を表示します。

- **操作**: 平易なツール名（Read file、Git diff、Search、Batch など）と、その下に元のツール名。
- **対象**: ファイルやディレクトリのパス、または「workspace search」「PLAN · iteration 2」のような固定表記。
- **結果**: 文字のバッジで表示します（色だけには頼りません）。**OK**、**Blocked**（アクティブなタスクが無い、または読み取り窓が閉じている——「アクセス制限」を参照）、**Denied**（機密ファイル・Git 無視ファイル・ワークスペース外のファイル）、**Error**、**Mixed**（結果が混在するバッチ。開くと各呼び出しを確認できます）。
- **所要時間**と、その呼び出しが属する**タスク**。

読みやすさのため、同じタスクの連続したファイル読み取り成功（互いに30秒以内）は「Read file × N」の1行にまとめます。拒否・ブロック・エラーはまとめません。**Group repeated reads** のチェックを外すと全件を個別に表示します。**Tool** と **Result** のフィルターは読み込み済みのページだけでなく履歴全体に適用され、**Load more** でさらに過去へ遡れます。ワークスペース単位・hub のどちらのダッシュボードでも同じように使えます。

記録される内容と、決して記録されない内容: 保存するのはメタデータ（時刻・ツール・コネクタ・タスク ID・安全な対象表記・結果の分類・短い理由コード・所要時間）のみです。**ファイルの内容、diff、検索クエリやヒット結果、メッセージ本文やタイトル、エラー文、ツールの生の引数・結果、シークレット、絶対パスは一切保存されません。** ワークスペース外を指すパスは固定のラベルに置き換えて表示します。これは「何にアクセスしたか」の監査記録であり、アクセスした内容の複製ではありません。

`wait` の待ち時間はデフォルトで 15 分です。タイムアウトした場合や状況を確認したいときは、そのまま再度 `wait` を実行します（タスクを再送する必要はありません）。

```bash
# 現在の状態を確認
gpt-worker state -w .

# 再度待機
gpt-worker wait -w .
```
> 💬 **チャットでは:** 「ChatGPT から返信が来ているか確認して」——必要に応じてエージェントが `state` と `wait` を実行します。

### 別のエージェントへのタスク引き継ぎ
作業中のエージェントが途中で停止せざるを得ない場合（レートリミットが近い、セッションが終了するなど）、ラウンドを通常どおり終える代わりに、タスクを別のエージェントへ引き継げます。

```bash
gpt-worker handoff --changed 3 --tests "ユニットテストは通過、結合テストは未実行" --reason "rate limit" -w .
```
> 💬 **チャットでは:** 「ChatGPT に引き継いで——レートリミットが近いので」

エージェントはここで待たずに終了します。ChatGPT がタスクの経緯——目標、完了した内容、下した判断、既に検討して見送った案——をまとめた引き継ぎ brief をキューに入れます。別のエージェントは通常の待機コマンドでそれを受け取ります。

```bash
gpt-worker wait -w .
```

brief はキューに 7 日間保持されるため、受け手はいつ開始しても構いません。別のモデル、別のセッション、あるいは同じマシンで翌日でも構いません。2 つのエージェント間でファイルやセッション状態を手動でコピーする必要はありません。タスクの状態は Worker 側で保持されているため、再開する側は前任者から直接引き継ぎを受けることなく作業を続けられます。

引き継がれるのは、ChatGPT が計画とレビューを通じて蓄積した文脈です。ローカルのエージェントが交代しても ChatGPT はタスクに留まり続けるため、引き継ぎ後のレビューでも、それ以前に行われた作業を踏まえた判断が行われます。

**前のエージェントが `handoff` を実行できないまま停止した場合**（途中で打ち切られ、正常に終了できなかった場合）、キューにはまだ引き継ぎ内容が入っていません。その場合は新しいエージェント自身が `handoff` を実行してタスクを引き取れます。`handoff` は引き継ぎ元・引き継ぎ先のどちらからでも実行できる共通コマンドです。Worker や ChatGPT はどちらのエージェントが呼んでいるかを区別せず、進捗情報として処理します。

```bash
gpt-worker handoff --reason "前のエージェントが報告せずに停止したため引き継ぐ" -w .
```
> 💬 **チャットでは:** 「前のエージェントが報告せずに停止したこのタスクを引き継いで」

`--changed` / `--tests` は省略するか、何も検証していないと正直に書いてください。自分がやっていない作業を報告する必要はありません——ChatGPT はどの報告に対しても `git_status` / `git_diff` でコードの実態を自ら確認します。これはタスクがまだラウンド途中の状態でのみ機能します。失敗した場合はすでに返信がキューにある可能性があるため、代わりに `gpt-worker wait` を実行してください。成功したら続けて `gpt-worker wait` を実行し、brief を受け取ってください。

引き継ぎ brief がメッセージサイズの上限（既定 16KB）に収まらない場合は、そのワークスペースの上限を引き上げられます。

```bash
gpt-worker limits 65536   # バイト単位。引数なしで実行すると現在値を表示
gpt-worker limits --reset # 既定値に戻す
```
> 💬 **チャットでは:** 「このプロジェクトの gpt-worker のメッセージサイズ上限を 64KB に上げて」／「gpt-worker のメッセージサイズ上限を既定値に戻して」

どちら側が書いたメッセージも、このワークスペースがタスクをまたいで使い回している同じ長期会話に載ります。上限を引き上げるほど、その会話がコンテキスト上限に達するペースも速まるため、安易に上げず必要な場合にのみ調整してください。

### 最新版へのアップデートと再デプロイ
`git pull` でツールを最新版に更新した際、Worker 側のコード（`worker/`）に変更が含まれている場合は、Worker の再デプロイを行います。

```bash
# 1. gpt-worker のディレクトリへ移動して最新コードを取得
cd /path/to/gpt-worker
git pull

# 2. Cloudflare Worker を再デプロイ
npm run deploy

# 3. 起動中のローカルブリッジがあれば再起動
gpt-worker stop -w /path/to/your-project
gpt-worker start -w /path/to/your-project
```
> **注意点**：
> - 再デプロイを行っても Worker の URL や既存の認証情報はそのまま保持されるため、ChatGPT 側のコネクタを再設定する必要はありません。
> - ローカルブリッジ（`bridge/`）のみの更新であれば Worker の再デプロイは不要ですが、迷った場合は `npm run deploy` を実行しておけば安全です。
> - ChatGPT は、コネクタの以前のツール定義も使い続けます。更新でツールの引数や説明が追加・変更された場合（例：`workspace_bundle` の `path`）は、ChatGPT の設定でコネクタを更新してください。更新するまでは、ChatGPT は古い定義で呼び出しを検証するため、新しい引数が拒否されます。
> - ChatGPT はコネクタ登録時に `initialize` の応答をキャッシュするため、運用指示の更新を反映させるには登録済みのコネクタを一度削除して再登録する必要があります。ただし毎回の再デプロイでこれを行う必要はありません。同じ指示は `next_task`（初回または指示変更時にバージョンハンドシェイクにより全文配信）や `operating_instructions` ツールでも配信されるため、再登録しなくても 1 ラウンドは正しく動作します。

### プロジェクトの登録を解除したい
不要になったプロジェクトの登録情報と Worker 上の記録を削除します。

```bash
gpt-worker remove -w /path/to/project --yes
```

---

## トラブルシューティングと安全上の注意

### Chrome の自動送信が動かない場合
既存の会話タブへ背面からメッセージを自動送信するには、Chrome の設定が必要です。

1. Chrome のメニューバーから **表示** → **開発** → **Apple EventsからのJavaScriptを許可** を有効にします。
2. 設定後、**Chrome を完全に再起動** してください。
3. 入力欄にテキストや下書き（メンション含む）が残っている場合でも、自律的な作業の継続性を優先するため、自動送信時は既存の内容を消去して新しいプロンプトが上書き投入されます。

### 安全上の注意
- **計画の確認**：ChatGPT が作成した計画（PLAN）は、実行前に必ず確認してください。意図しないファイルの削除や外部通信（curl など）が含まれていないかチェックします。
- **機密ファイルの保護**：`.env`、秘密鍵、`.ssh`、`.aws` などの機密ファイルは、ChatGPT からの読み取り要求があっても自動的に拒否されます。
- **アクセス制限**：ChatGPT がファイルを読み取れるのは、アクティブなタスクが存在する間だけです。

### データの保持期間
ステップ3でデプロイした、ご自身の Cloudflare Worker 上にタスクのやり取りが一定期間保持されます（チャットとローカルのみで完結する構成に比べ、Worker 上に一時データが残ります）。
- **タスク本文**（目標テキスト、計画、実行報告）は、配信され確認応答が返されてから7日後に Worker 上から自動的に削除されます。
- **タスク履歴**（ChatGPT に過去のタスクの文脈を渡すための目標テキストと結果概要）は、タスクが完了または保留などの最終状態に達してから30日後に Worker 上から自動的に削除されます。進行中のタスクは削除されません。
- **MCP アクセス履歴**（メタデータのみ——[MCP アクセス履歴](#mcp-アクセス履歴)を参照）は各呼び出しから24時間後に削除され、1ワークスペースあたり最新1000件のみが保持されます。`gpt-worker remove` でワークスペースと一緒に削除されます。
- **[Web ダッシュボード](#web-ダッシュボード)のセッション**は24時間で失効し、自動的に掃除されます。ワークスペース単位のダッシュボードはそのワークスペースの owner token をローテーションした場合やワークスペースを削除した場合、hub ダッシュボードは共有 hub token をローテーションした場合に即座に無効化されます。
- ワークスペースのタスク・キュー記録を Cloudflare アカウントから完全に消去するには `gpt-worker remove -w <dir> --yes` を実行してください（[プロジェクトの登録を解除したい](#プロジェクトの登録を解除したい)を参照）。個別のタスク履歴だけを削除する手段はなく、ワークスペースごと削除する必要があります。

---

## コマンド一覧

| コマンド | 説明 |
|---|---|
| `gpt-worker init -w <dir> [--worker-url <https-url>] [--skip-preflight]` | プロジェクトを登録（初回は Worker をデプロイ）。Cloudflare 操作の前に Node・Git・秘密スキャナを確認します。`--worker-url` は期待する `*.workers.dev` エンドポイントを任意で指定するもので、現在の Wrangler プロジェクトがデプロイした Worker と一致しない限り管理シークレットを設定しません。`--skip-preflight` はローカル前提チェックを省略します。 |
| `gpt-worker url [-w <dir>]` | WebUI（ダッシュボード）URL、OAuth Server URL、認証トークンを表示（`-w` を付けるとそのワークスペース専用 URL を表示） |
| `gpt-worker start -w <dir>` | ローカルブリッジ（通信プロセス）を起動 |
| `gpt-worker stop -w <dir>` | ローカルブリッジを停止 |
| `gpt-worker status -w <dir>` | ローカルブリッジの診断、読取ゲート、READ許可・禁止パス、ログパス、検証済みのチャット紐付け、Worker 接続、アクティブタスクの詳細を確認。Worker 障害時は未紐付けと誤表示せず利用不可として表示します。 |
| `gpt-worker logs [-w <dir>] [-n <lines>] [--all] [--path]` | ローカルブリッジログの末尾50行を表示（保持しているローテーションも対象）。`--path` は `tail -f` 用のパス表示、`--all` は移動・削除済みのものも含むローカル登録済み全ワークスペースを対象にします。Worker への接続は不要です。 |
| `gpt-worker task "<goal>" [-w <dir>] [--title "<title>"]` | ChatGPT に新しいタスクを依頼 |
| `gpt-worker wait -w <dir>` | ChatGPT の応答（計画またはレビュー結果）を待機 |
| `gpt-worker report [-w <dir>] [--title "<title>"]` | 実装結果やテスト内容を ChatGPT に報告 |
| `gpt-worker complete -w <dir>` | LOCAL_DECISION（判断待ち）状態のレビュー/計画タスクの完了を確定 |
| `gpt-worker continue -w <dir>` | LOCAL_DECISION 状態のレビュータスクを EXECUTING に戻して指摘事項の実装を継続 |
| `gpt-worker handoff [-w <dir>] [--reason "<理由>"] [--title "<title>"]` | ラウンドを終えてタスクを別のエージェントに引き継ぐ（受け手は `wait` で再開） |
| `gpt-worker discard-task [-w <dir>] [--task <id>] --yes` | アクティブなタスクを破棄する（BLOCKED にし、キュー内のメッセージを消去）。元に戻せないため `--yes` が必須。`wait` が終了コード 3 で終わって滞留したタスクからの復旧手段 |
| `gpt-worker queue [-w <dir>] [--task <id>] [--discard <id>]` | 保留中のキューメッセージの確認や、滞留したメッセージの破棄 |
| `gpt-worker limits [<bytes>\|--reset] [-w <dir>]` | このワークスペースのメッセージ本文サイズ上限を表示・変更する（既定 16KB） |
| `gpt-worker guidance "<text>" -w <dir>` | プロジェクト固有の開発ルールを設定 |
| `gpt-worker chat-url "<url>" -w <dir>` | ChatGPT Project の URL を登録・変更 |
| `gpt-worker chat <new\|attach\|status> ... -w <dir>` | 新しいチャットの開始、手動で開いた会話の紐付け、または復旧状態の確認 |
| `gpt-worker show-config [-w <dir>]` | ブラウザ連携の設定内容を確認 |
| `gpt-worker allow-read <path> -w <dir>` | Git 無視ファイル・ディレクトリの個別読み取りを許可 |
| `gpt-worker unallow-read <path> -w <dir>` | Git 無視ファイル・ディレクトリの個別許可を解除 |
| `gpt-worker allow-list -w <dir>` | 個別許可されたファイル・ディレクトリ一覧を表示 |
| `gpt-worker deny-read <path> -w <dir>` | ファイルまたはディレクトリの個別読み取りを明示的に禁止 |
| `gpt-worker undeny-read <path> -w <dir>` | 個別読み取りの明示的禁止を解除 |
| `gpt-worker deny-list -w <dir>` | 明示的に読み取り禁止されたパス一覧を表示 |
| `gpt-worker state -w <dir>` | 現在のタスク状態を JSON で確認 |
| `gpt-worker rotate <--gpt\|--link\|--cli\|--hub> [-w <dir>]` | 認証トークン（ワークスペースの GPT/link/CLI トークン、または共有 hub トークン）を再生成 |
| `gpt-worker workspaces` | 登録済みプロジェクト一覧を表示 |
| `gpt-worker remove -w <dir> --yes` | プロジェクトの登録を解除 |

設定済みのワークスペースがなくても、`gpt-worker help`、`gpt-worker help <command>`、または `gpt-worker <command> --help` で利用可能なコマンドを確認できます。

### 終了コード

| コード | 意味 |
|---|---|
| `0` | 成功 |
| `1` | エラー（メッセージに対処方法が出ます） |
| `2` | `wait` がタイムアウトし、まだ返信がない — もう一度実行する。ChatGPT に `workspace_bundle` のアーカイブを渡したあと沈黙が続いている場合は、その旨がメッセージに出ます（ChatGPT の画面で承認待ちかもしれません） |
| `3` | `wait` は返信を受け取ったが、タスクが先に進まなかった。返信は表示されます。`gpt-worker state` で確認し、本当に滞留しているなら `gpt-worker discard-task --yes` |
| `4` | Worker に接続できなかった。`task`/`report`/`handoff` ではリクエストが反映された可能性があるかどうかがメッセージに出ます — 再実行する前に `gpt-worker state` で確認してください。`wait` は、返信を表示した直後に、その確認応答（ack）を確認できなかった場合にも 4 で終わります。再配信されると決めつけず、表示される案内（`gpt-worker state` と `gpt-worker queue --task <task id>` の確認）に従ってください |

コマンドは一時的なネットワーク障害を自動で再試行します（短い間隔で数回）。`wait` はさらに、自身のタイムアウトまで再試行を続けるので、長い待機中の短い接続断で終了することはありません。

---

## 開発者向け情報

gpt-worker 自体のテストや動作確認を行う場合のコマンドです。

```bash
npm run check    # 構文チェック
npm test         # テストの実行
npm run coverage # Node 組み込みのカバレッジレポート付きでテストを実行（verify には含まれません）
npm run verify   # チェックとテストを一括実行
npm run dry-run  # Worker デプロイの事前確認
npm run deploy   # Cloudflare Worker のデプロイ
```

---

## 謝辞

本プロジェクトは、ChatGPT Web版をコーディングの思考エンジンとして活用する手法を開拓した **[XiaoDuoYa/codex-with-chatgpt](https://github.com/XiaoDuoYa/codex-with-chatgpt)** に強い着想を得て作成されました。先駆的なアイデアと実装に感謝いたします。

---

## ライセンス

[MIT](LICENSE) © 2026 Nihondo

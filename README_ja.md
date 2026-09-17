# gpt-worker

**開発中・実験的プロジェクトです。使用にあたっては自己責任でお願いします。**

**gpt-worker** は、Web ブラウザ版の ChatGPT（Plus, Team, Pro）を「計画・レビュー役（頭脳）」として使い、手元のローカルエージェント（Claude Code、Antigravity、Codex など）やあなた自身が「実行役（手足）」としてコードを編集・テストする開発支援ツールです。

ChatGPT の API トークン料金を消費することなく、ブラウザ版の高度な推論能力を作業ループに取り込めます。

このツールは、[XiaoDuoYa/codex-with-chatgpt](https://github.com/XiaoDuoYa/codex-with-chatgpt) に着想を得ています。ChatGPT Web とローカルブリッジとの連携を Cloudflare Workers上のメッセージハブを介した形で実現し、ターゲットを macOS、Google Chrome に限定することでコンパクトにした開発支援ツールです。
素晴らしいアイデアを提供してくださった XiaoDuoYa さんに感謝いたします。

```text
[ChatGPT Project] ──(MCP / HTTPS)──> [Cloudflare Worker (中継ハブ)] ──(WebSocket)──> [ローカル環境 (bridge)]
```

---

## 主な特長

- **API 課金ゼロ**：日常使っている ChatGPT の月額サブスクリプション（Web版）を利用するため、トークン従量課金が発生しません。
- **1回設定するだけの共通ハブ**：中継用の Cloudflare Worker と ChatGPT 側の設定は最初の1度だけです。2つ目以降のプロジェクトはローカルコマンド1つで瞬時に追加できます。
- **安全な読み取り専用設計**：ChatGPT はリポジトリの調査と計画の立案のみを行います。ファイルの変更やコマンド実行は必ずローカル側で検証してから行います。
- **機密情報の自動保護**：`.env`、秘密鍵、`.ssh`、`.aws` などの機密ファイルや、Git で無視されているファイルは自動的に ChatGPT から隠されます。さらに、すべてのツール結果は外部の秘密スキャナ（betterleaks/gitleaks）で検査され、検出された秘密情報はその場でマスクされてから ChatGPT に届きます。
- **Chrome による自動入力と送信**：タスク発行時に Chrome で該当プロジェクトを開き、バックグラウンド（画面フォーカスを奪わずに）でメッセージの入力や送信まで行えます。
- **追加パッケージ不要**：Node.js の標準機能だけで作られており、余計なライブラリのインストールは不要です。

---

## 前提条件

- **OS**：macOS（Chrome 自動連携機能を使用する場合）
- **Node.js**：v22 以上（未導入の場合は `brew install node`）
- **Google Chrome**：ChatGPT を操作するブラウザ
- **ChatGPT サブスクリプション**：Plus、Team、Pro のいずれか（Developer mode と Projects 機能が使えること）
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

> **任意・Claude Code または Codex CLI:** 上記のスキルは今の対話ターンの中でそのまま実行されるため、`wait`（最大15分）のたびにそのセッションが塞がり、各ラウンドの出力もコンテキストに積み上がります。どちらのツールも、引き継ぎループ全体をサブエージェントとして走らせられます。セッションを解放しつつ、ループ自体のやり取りをコンテキスト外に追い出したい場合は、以下も併せてリンクしてください。
> ```bash
> # Claude Code
> mkdir -p ~/.claude/agents
> ln -s "$(pwd)/.claude/agents/gpt-worker.md" ~/.claude/agents/gpt-worker.md
>
> # Codex CLI
> mkdir -p ~/.codex/agents
> ln -s "$(pwd)/.codex/agents/gpt-worker.toml" ~/.codex/agents/gpt-worker.toml
> ```
> あとは「gpt-worker エージェントで実行して」のように名指しで頼むだけです。どちらの経路も同じプロトコルに従うので、タスクの想定所要時間に応じて使い分けてください。（Codex のカスタムエージェント機能はまだ新しく変化中の機能です。お使いの Codex CLI のバージョンで上記 TOML が読み込めない場合は、スキル呼び出しにフォールバックしてください。）

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
   - ChatGPT 画面左下のユーザー名をクリックし、**設定** → **Developer mode** をオンにします。
2. **MCP Connector を登録する**：
   - **設定** → **Connectors**（または Developer mode 設定）から新しいコネクタを追加します。
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
   - 運用プロトコルの本文はコネクタ自身が配信します：`initialize` の応答、`operating_instructions` ツール、そして `next_task` で渡される各タスクに同梱される形で届きます。他に貼り付けるものはなく、gpt-worker を更新しても貼り直す必要はありません。
   - 欄を空のままにしても動作します。上記の 1 行は、新しい会話の最初のターンでのみ ChatGPT を助けるものです。
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

### 新しいチャットの開始と会話の復旧

各ワークスペースは、継続先として ChatGPT の会話 URL を保存できます。Chrome の tab ID は短命な高速化情報に過ぎません。tab ID が無効なら、まず保存済み会話 URL のタブを探し、見つからない場合はその URL を置換 tab で開きます。会話が長くなった場合や、ブラウザ自動化が別プロファイルを開いた場合は、次を使用します。

```bash
# 同じ Project 内で、次の task/report を新しい ChatGPT 会話として開始します。
# Worker のタスクを取り消したり、登録済み Project URL を変更したりはしません。
gpt-worker chat new -w .

# 登録済み Project 内で手動で開いた会話を、このワークスペースに紐付けます。
gpt-worker chat attach "https://chatgpt.com/g/g-p-.../c/..." -w .

# Project と紐付け済み会話を確認します。
gpt-worker chat status -w .
```
> 💬 **チャットでは:** 「このプロジェクト用に新しい ChatGPT の会話を始めて」／「このプロジェクトを &lt;url&gt; の ChatGPT 会話に紐付けて」／「このプロジェクトはどの ChatGPT 会話に紐付いている？」

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

---

## よくある操作・逆引きガイド

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

### Git で無視されている特定ファイルを読み取らせたい
`.gitignore` に含まれるファイルは通常 ChatGPT から隠されます。特定の 1 ファイルだけ読み取りを許可したい場合は次のように実行します。

```bash
# 特定のファイルを許可
gpt-worker allow-read config/test-fixture.json -w .

# 許可中のファイル一覧を確認
gpt-worker allow-list -w .

# 許可を取り消す
gpt-worker deny-read config/test-fixture.json -w .
```
※ `.env` や秘密鍵などの機密ファイルは、このコマンドを使っても安全のため保護され、読み取ることはできません。

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

### 待ち時間がタイムアウトしたとき
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

brief はキューに 7 日間保持されるため、受け手はいつ開始しても構いません。別のモデル、別のセッション、あるいは同じマシンで翌日でも構いません。2 つのエージェント間で何かをコピーする必要はありません。タスクの状態は Worker が保持しているため、再開する側は停止した側から何も引き継ぐ必要がないためです。

引き継がれるのは、ChatGPT が計画とレビューを通じて蓄積した文脈です。ローカルのエージェントが交代しても ChatGPT はタスクに留まり続けるため、引き継ぎ後のレビューでも、それ以前に行われた作業を踏まえた判断が行われます。

**前のエージェントが `handoff` を実行できないまま停止した場合**（途中で打ち切られ、正常に終了できなかった場合）、キューには何も入っていません。その場合は新しいエージェントが自分で `handoff` を実行してタスクを引き取れます。`handoff` はどちら向きにも使える同じコマンドで、`report` と同様に EXECUTED を1件キューに積むだけなので、ChatGPT や Worker はどちらのエージェントが呼んでいるかを区別しません。

```bash
gpt-worker handoff --reason "前のエージェントが報告せずに停止したため引き継ぐ" -w .
```
> 💬 **チャットでは:** 「前のエージェントが報告せずに停止したこのタスクを引き継いで」

`--changed` / `--tests` は省略するか、何も検証していないと正直に書いてください。自分がやっていない作業を報告する必要はありません——ChatGPT はどの EXECUTED に対しても `git_status` / `git_diff` で実態を自ら確認します。これはタスクがまだラウンド途中の状態でのみ機能します。失敗した場合はすでに返信がキューにある可能性があるため、代わりに `gpt-worker wait` を実行してください。成功したら続けて `gpt-worker wait` を実行し、brief を受け取ってください。

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
> - ChatGPT はコネクタ登録時に `initialize` の応答をキャッシュするため、運用指示の更新を反映させるには登録済みのコネクタを一度削除して再登録する必要があります。ただし毎回の再デプロイでこれを行う必要はありません。同じ指示は `next_task` で渡される各タスクや `operating_instructions` ツールでも配信されるため、再登録しなくても 1 ラウンドは正しく動作します。

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
ステップ3でデプロイした、あなた自身の Cloudflare アカウント上の Worker がタスクのやり取りを永続的に保存します。これはチャットとローカルにしか残らない構成と比べて、残留データが増えることを意味します。
- **タスク本文**（目標テキスト、計画、実行報告）は、配信され確認応答が返されてから7日後に Worker 上から自動的に削除されます。
- **タスク履歴**（ChatGPT に過去のタスクの文脈を渡すための目標テキストと結果概要）は、タスクが完了または保留などの最終状態に達してから30日後に Worker 上から自動的に削除されます。進行中のタスクは削除されません。
- ワークスペースのタスク・キュー記録を Cloudflare アカウントから完全に消去するには `gpt-worker remove -w <dir> --yes` を実行してください（[プロジェクトの登録を解除したい](#プロジェクトの登録を解除したい)を参照）。個別のタスク履歴だけを削除する手段はなく、ワークスペースごと削除する必要があります。

---

## コマンド一覧

| コマンド | 説明 |
|---|---|
| `gpt-worker init -w <dir>` | プロジェクトを登録（初回は Worker をデプロイ） |
| `gpt-worker url [-w <dir>]` | ChatGPT に登録する Server URL と認証トークンを表示（`-w` を付けるとそのワークスペース専用のコネクタ URL を表示） |
| `gpt-worker start -w <dir>` | ローカルブリッジ（通信プロセス）を起動 |
| `gpt-worker stop -w <dir>` | ローカルブリッジを停止 |
| `gpt-worker status -w <dir>` | ブリッジの稼働状況とタスク状態を確認 |
| `gpt-worker task "<goal>" -w <dir>` | ChatGPT に新しいタスクを依頼 |
| `gpt-worker wait -w <dir>` | ChatGPT の応答（計画またはレビュー結果）を待機 |
| `gpt-worker report -w <dir>` | 実装結果やテスト内容を ChatGPT に報告 |
| `gpt-worker handoff -w <dir> [--reason "<理由>"]` | ラウンドを終えてタスクを別のエージェントに引き継ぐ（受け手は `wait` で再開） |
| `gpt-worker limits [<bytes>\|--reset] [-w <dir>]` | このワークスペースのメッセージ本文サイズ上限を表示・変更する（既定 16KB） |
| `gpt-worker guidance "<text>" -w <dir>` | プロジェクト固有の開発ルールを設定 |
| `gpt-worker chat-url "<url>" -w <dir>` | ChatGPT Project の URL を登録・変更 |
| `gpt-worker chat <new\|attach\|status> ... -w <dir>` | 新しいチャットの開始、手動で開いた会話の紐付け、または復旧状態の確認 |
| `gpt-worker show-config [-w <dir>]` | ブラウザ連携の設定内容を確認 |
| `gpt-worker allow-read <file> -w <dir>` | Git 無視ファイルの個別読み取りを許可 |
| `gpt-worker allow-list -w <dir>` | 個別許可されたファイル一覧を表示 |
| `gpt-worker deny-read <file> -w <dir>` | 個別読み取りの許可を取り消し |
| `gpt-worker state -w <dir>` | 現在のタスク状態を JSON で確認 |
| `gpt-worker workspaces` | 登録済みプロジェクト一覧を表示 |
| `gpt-worker remove -w <dir> --yes` | プロジェクトの登録を解除 |

---

## 開発者向け情報

gpt-worker 自体のテストや動作確認を行う場合のコマンドです。

```bash
npm run check    # 構文チェック
npm test         # テストの実行
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

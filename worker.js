// ==================================================
// NiSC チャットボット
// Cloudflare Workers 完全版
//
// 必要なVariables and Secrets
// 1. GEMINI_API_KEY：Secret
// 2. LOG_ENDPOINT：Plaintext
// 3. LOG_SECRET：Secret
// ==================================================


// ==================================================
// 必ず変更する場所
// ==================================================

// Googleスプレッドシートの
// 「ウェブに公開 → CSV」で取得したURL
const SHEET_CSV_URL =
  'https://docs.google.com/spreadsheets/d/e/2PACX-1vSVG5gwLDZPW1YHCUEYmN-uNrHcqSNq-m3XbXANbGSLsOZPRVquEY98IDnZ1wznhJArO2YZgKrpsJot/pub?gid=0&single=true&output=csv';


// ==================================================
// 基本設定
// ==================================================

const GEMINI_MODEL =
  'gemini-3.1-flash-lite';

const FALLBACK_MESSAGE =
  '申し訳ありません。このチャットボットでは正確な情報を確認できませんでした。' +
  'NiSC公式Instagram（@nisc.sg）のDMまたはメール' +
  '（nus.nisc@gmail.com）からお問い合わせください。';


// ==================================================
// Workerの入口
// ==================================================

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // チャット画面
    if (
      request.method === 'GET' &&
      url.pathname === '/'
    ) {
      return new Response(
        getHtml(),
        {
          status: 200,
          headers: {
            'Content-Type':
              'text/html; charset=UTF-8',

            'Cache-Control':
              'no-store'
          }
        }
      );
    }

    // 設定確認用
    if (
      request.method === 'GET' &&
      url.pathname === '/health'
    ) {
      return jsonResponse({
        ok: true,
        service: 'NiSC Chatbot',
        time: new Date().toISOString(),

        sheetConfigured:
          Boolean(SHEET_CSV_URL) &&
          !SHEET_CSV_URL.includes(
            'ここにGoogle'
          ),

        geminiConfigured:
          Boolean(env.GEMINI_API_KEY),

        logEndpointConfigured:
          Boolean(env.LOG_ENDPOINT),

        logSecretConfigured:
          Boolean(env.LOG_SECRET)
      });
    }

    // チャットの質問受付
    if (
      request.method === 'POST' &&
      url.pathname === '/api/chat'
    ) {
      return handleChat(
        request,
        env
      );
    }

    return new Response(
      'Not Found',
      {
        status: 404
      }
    );
  }
};


// ==================================================
// チャット処理
// ==================================================

async function handleChat(
  request,
  env
) {
  let question = '';

  try {
    if (!env.GEMINI_API_KEY) {
      throw new Error(
        'GEMINI_API_KEYが設定されていません。'
      );
    }

    let requestBody;

    try {
      requestBody =
        await request.json();

    } catch (error) {
      return jsonResponse(
        {
          ok: false,
          error:
            '送信データの形式が正しくありません。'
        },
        400
      );
    }

    question =
      typeof requestBody.question ===
      'string'
        ? requestBody.question
            .trim()
            .slice(0, 1000)
        : '';

    if (!question) {
      return jsonResponse(
        {
          ok: false,
          error:
            '質問を入力してください。'
        },
        400
      );
    }

    // GoogleスプレッドシートからFAQ取得
    const knowledge =
      await getKnowledge();

    // Gemini用プロンプト
    const prompt =
      buildPrompt(
        question,
        knowledge
      );

    // Geminiで回答生成
    const answer =
      await callGemini(
        prompt,
        env.GEMINI_API_KEY
      );

    // GASへ質問ログを送る
    const logResult =
      await saveQuestionLog(
        env,
        question,
        answer,
        '回答成功'
      );

    console.log(
      'ログ保存結果',
      JSON.stringify(logResult)
    );

    return jsonResponse({
      ok: true,
      answer
    });

  } catch (error) {
    const errorMessage =
      String(
        error?.message || error
      );

    console.error(
      'チャット処理エラー',
      errorMessage
    );

    // エラー時もログを保存
    try {
      await saveQuestionLog(
        env,
        question || '質問取得失敗',
        FALLBACK_MESSAGE,
        'エラー：' +
          errorMessage.slice(0, 500)
      );

    } catch (logError) {
      console.error(
        'エラーログ保存失敗',
        String(
          logError?.message ||
          logError
        )
      );
    }

    return jsonResponse({
      ok: false,
      answer: FALLBACK_MESSAGE
    });
  }
}


// ==================================================
// GoogleスプレッドシートからFAQを取得
// ==================================================

async function getKnowledge() {
  if (
    !SHEET_CSV_URL ||
    SHEET_CSV_URL.includes(
      'ここにGoogle'
    )
  ) {
    throw new Error(
      'SHEET_CSV_URLが設定されていません。'
    );
  }

  const response =
    await fetch(
      SHEET_CSV_URL,
      {
        method: 'GET',

        headers: {
          'User-Agent':
            'NiSC-Chatbot'
        },

        // 最大約60秒キャッシュ
        cf: {
          cacheEverything: true,
          cacheTtl: 60
        }
      }
    );

  if (!response.ok) {
    throw new Error(
      'FAQ取得エラー：' +
      response.status +
      ' ' +
      response.statusText
    );
  }

  const csvText =
    await response.text();

  // CSVではなくGoogleのログイン画面などが
  // 返ってきた場合
  const beginning =
    csvText
      .trim()
      .slice(0, 200)
      .toLowerCase();

  if (
    beginning.includes(
      '<!doctype html'
    ) ||
    beginning.includes(
      '<html'
    )
  ) {
    throw new Error(
      'FAQシートがCSVとして公開されていません。'
    );
  }

  const rows =
    parseCsv(csvText);

  if (rows.length < 2) {
    throw new Error(
      'FAQナレッジにデータがありません。'
    );
  }

  const headers =
    rows[0].map(function(value) {
      return String(value)
        .replace(/^\uFEFF/, '')
        .trim();
    });

  const idIndex =
    headers.indexOf('ID');

  const categoryIndex =
    headers.indexOf(
      'カテゴリ'
    );

  const questionIndex =
    headers.indexOf(
      '想定質問'
    );

  const answerIndex =
    headers.indexOf(
      '回答'
    );

  const keywordIndex =
    headers.indexOf(
      '検索キーワード'
    );

  const urlIndex =
    headers.indexOf(
      '参照URL'
    );

  const statusIndex =
    headers.indexOf(
      '確認状況'
    );

  if (
    categoryIndex === -1 ||
    questionIndex === -1 ||
    answerIndex === -1
  ) {
    throw new Error(
      'FAQシートに「カテゴリ」「想定質問」「回答」の列が必要です。'
    );
  }

  const approvedStatuses = [
    '確認済み',
    '公式確認済み',
    '修正済み'
  ];

  const knowledgeItems =
    rows
      .slice(1)
      .filter(function(row) {
        const faqQuestion =
          String(
            row[questionIndex] || ''
          ).trim();

        const faqAnswer =
          String(
            row[answerIndex] || ''
          ).trim();

        const status =
          statusIndex !== -1
            ? String(
                row[statusIndex] || ''
              ).trim()
            : '';

        const hasContent =
          faqQuestion !== '' &&
          faqAnswer !== '';

        const isApproved =
          statusIndex === -1 ||
          status === '' ||
          approvedStatuses.includes(
            status
          );

        return (
          hasContent &&
          isApproved
        );
      })
      .map(function(row) {
        const parts = [];

        if (
          idIndex !== -1 &&
          row[idIndex]
        ) {
          parts.push(
            'FAQ ID：' +
            row[idIndex]
          );
        }

        parts.push(
          'カテゴリ：' +
          String(
            row[categoryIndex] || ''
          )
        );

        parts.push(
          '想定質問：' +
          String(
            row[questionIndex] || ''
          )
        );

        parts.push(
          '回答：' +
          String(
            row[answerIndex] || ''
          )
        );

        if (
          keywordIndex !== -1 &&
          row[keywordIndex]
        ) {
          parts.push(
            '検索キーワード：' +
            row[keywordIndex]
          );
        }

        if (
          urlIndex !== -1 &&
          row[urlIndex]
        ) {
          parts.push(
            '参照URL：' +
            row[urlIndex]
          );
        }

        return parts.join('\n');
      });

  if (
    knowledgeItems.length === 0
  ) {
    throw new Error(
      '回答に使用できるFAQがありません。'
    );
  }

  return knowledgeItems.join(
    '\n\n---\n\n'
  );
}


// ==================================================
// Gemini用プロンプト
// ==================================================

function buildPrompt(
  question,
  knowledge
) {
  return `
あなたは、シンガポール日本人学生会
（NiSC／Nihon Student Club）の
公式ウェブサイトで質問に答える
案内チャットボットです。

利用者は、シンガポールで学ぶ学生、
留学予定者、保護者、学校・企業・団体の
担当者などです。

【回答ルール】

1. 以下のNiSCナレッジだけを
   根拠として回答してください。

2. ナレッジにない情報を推測して
   作らないでください。

3. 日本語の質問には日本語で、
   英語の質問には英語で回答してください。

4. 親しみやすく丁寧な表現を
   使用してください。

5. 回答は原則250文字以内で、
   簡潔かつ分かりやすくしてください。

6. 必要に応じて短い箇条書きを
   使用しても構いません。

7. 入試、学費、奨学金、
   Student's Pass、ビザ、寮、
   入国条件、大学ランキングなどは
   変更される可能性があります。

8. 制度に関する内容では、
   必要に応じて大学や政府機関の
   公式情報を確認するよう
   案内してください。

9. NiSCは大学やシンガポール政府を
   代表する団体ではありません。

10. 合格、奨学金取得、寮への入居、
    ビザ承認などを保証しないでください。

11. LINEグループの招待リンク、
    パスワード、身分証番号などの
    非公開情報や個人情報を
    回答しないでください。

12. ナレッジ内に関連する参照URLが
    ある場合は回答に含めても構いません。

13. ナレッジ内に回答できる情報が
    ない場合は、次の文章だけを
    回答してください。

「${FALLBACK_MESSAGE}」

【NiSCナレッジ】

${knowledge}

【利用者の質問】

${question}

【回答】
`;
}


// ==================================================
// Gemini API
// ==================================================

async function callGemini(
  prompt,
  apiKey
) {
  const endpoint =
    'https://generativelanguage.googleapis.com/v1beta/models/' +
    encodeURIComponent(
      GEMINI_MODEL
    ) +
    ':generateContent';

  const response =
    await fetch(
      endpoint,
      {
        method: 'POST',

        headers: {
          'Content-Type':
            'application/json',

          'x-goog-api-key':
            apiKey
        },

        body: JSON.stringify({
          contents: [
            {
              role: 'user',

              parts: [
                {
                  text: prompt
                }
              ]
            }
          ],

          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 500
          }
        })
      }
    );

  const responseText =
    await response.text();

  if (!response.ok) {
    throw new Error(
      'Gemini APIエラー（' +
      response.status +
      '）：' +
      responseText
    );
  }

  let data;

  try {
    data =
      JSON.parse(responseText);

  } catch (error) {
    throw new Error(
      'Geminiのレスポンスを解析できませんでした。'
    );
  }

  const answer =
    data.candidates?.[0]
      ?.content?.parts
      ?.map(function(part) {
        return part.text || '';
      })
      .join('')
      .trim();

  if (!answer) {
    throw new Error(
      'Geminiから回答が返されませんでした。'
    );
  }

  return answer;
}


// ==================================================
// GASへ質問ログを保存
// ==================================================

async function saveQuestionLog(
  env,
  question,
  answer,
  status
) {
  if (!env.LOG_ENDPOINT) {
    console.error(
      'LOG_ENDPOINTが設定されていません。'
    );

    return {
      ok: false,
      error:
        'LOG_ENDPOINT未設定'
    };
  }

  if (!env.LOG_SECRET) {
    console.error(
      'LOG_SECRETが設定されていません。'
    );

    return {
      ok: false,
      error:
        'LOG_SECRET未設定'
    };
  }

  const payload = {
    secret: env.LOG_SECRET,

    question:
      String(question || '')
        .slice(0, 2000),

    answer:
      String(answer || '')
        .slice(0, 5000),

    status:
      String(
        status || '回答成功'
      ).slice(0, 500)
  };

  try {
    const response =
      await fetch(
        env.LOG_ENDPOINT,
        {
          method: 'POST',

          headers: {
            'Content-Type':
              'application/json'
          },

          body:
            JSON.stringify(payload),

          redirect: 'follow'
        }
      );

    const responseText =
      await response.text();

    console.log(
      'GASレスポンス',
      response.status,
      responseText
    );

    let result;

    try {
      result =
        JSON.parse(responseText);

    } catch (error) {
      result = {
        ok: false,
        error:
          'GASからJSON以外の回答が返されました。',
        responseText:
          responseText.slice(0, 500)
      };
    }

    if (
      !response.ok ||
      result.ok !== true
    ) {
      console.error(
        'GASログ保存エラー',
        JSON.stringify(result)
      );

      return {
        ok: false,
        status:
          response.status,
        result
      };
    }

    return {
      ok: true
    };

  } catch (error) {
    console.error(
      'GASへのログ送信失敗',
      String(
        error?.message || error
      )
    );

    return {
      ok: false,
      error:
        String(
          error?.message || error
        )
    };
  }
}


// ==================================================
// CSV解析
// ==================================================

function parseCsv(csvText) {
  const rows = [];

  let row = [];
  let value = '';
  let insideQuotes = false;

  for (
    let index = 0;
    index < csvText.length;
    index++
  ) {
    const character =
      csvText[index];

    const nextCharacter =
      csvText[index + 1];

    if (insideQuotes) {
      if (
        character === '"' &&
        nextCharacter === '"'
      ) {
        value += '"';
        index++;

      } else if (
        character === '"'
      ) {
        insideQuotes = false;

      } else {
        value += character;
      }

    } else {
      if (character === '"') {
        insideQuotes = true;

      } else if (
        character === ','
      ) {
        row.push(value);
        value = '';

      } else if (
        character === '\n'
      ) {
        row.push(value);
        rows.push(row);

        row = [];
        value = '';

      } else if (
        character !== '\r'
      ) {
        value += character;
      }
    }
  }

  if (
    value !== '' ||
    row.length > 0
  ) {
    row.push(value);
    rows.push(row);
  }

  return rows;
}


// ==================================================
// JSONレスポンス
// ==================================================

function jsonResponse(
  data,
  status = 200
) {
  return new Response(
    JSON.stringify(data),
    {
      status,

      headers: {
        'Content-Type':
          'application/json; charset=UTF-8',

        'Cache-Control':
          'no-store'
      }
    }
  );
}


// ==================================================
// チャット画面
// ==================================================

function getHtml() {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">

  <meta
    name="viewport"
    content="width=device-width, initial-scale=1"
  >

  <title>NiSC チャットボット</title>

  <style>
    * {
      box-sizing: border-box;
    }

    html,
    body {
      width: 100%;
      height: 100%;
      margin: 0;
    }

    body {
      font-family:
        -apple-system,
        BlinkMacSystemFont,
        "Segoe UI",
        "Noto Sans JP",
        "Hiragino Sans",
        "Yu Gothic",
        sans-serif;

      background: #ffffff;
      color: #222222;
    }

    .chat-container {
      display: flex;
      flex-direction: column;

      width: 100%;
      max-width: 900px;
      min-height: 620px;
      height: 100vh;

      margin: 0 auto;

      background: #ffffff;
    }

    .chat-header {
      padding: 24px 28px;

      background: #184782;
      color: #ffffff;
    }

    .chat-title {
      margin: 0;

      font-size: 28px;
      font-weight: 700;
    }

    .chat-subtitle {
      margin: 8px 0 0;

      font-size: 15px;
      line-height: 1.6;
    }

    .messages {
      flex: 1;

      padding: 24px;

      overflow-y: auto;
      scroll-behavior: smooth;
    }

    .message-row {
      display: flex;

      width: 100%;
      margin-bottom: 16px;
    }

    .bot-row {
      justify-content:
        flex-start;
    }

    .user-row {
      justify-content:
        flex-end;
    }

    .message {
      max-width: 85%;

      padding: 16px 18px;

      border-radius: 16px;

      font-size: 15px;
      line-height: 1.75;

      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }

    .bot-message {
      background: #edf3fb;
      color: #222222;

      border-bottom-left-radius:
        4px;
    }

    .user-message {
      background: #184782;
      color: #ffffff;

      border-bottom-right-radius:
        4px;
    }

    .loading-message {
      color: #687386;
      font-style: italic;
    }

    .suggestions {
      padding:
        0 24px 16px;

      background: #ffffff;
    }

    .suggestions-title {
      margin: 0 0 8px;

      color: #687386;
      font-size: 12px;
    }

    .suggestion-buttons {
      display: flex;
      gap: 8px;

      overflow-x: auto;
      padding-bottom: 3px;
    }

    .suggestion-button {
      flex: 0 0 auto;

      padding: 9px 14px;

      border:
        1px solid #184782;

      border-radius: 20px;

      background: #ffffff;
      color: #184782;

      font: inherit;
      font-size: 12px;

      cursor: pointer;
    }

    .suggestion-button:hover {
      background: #edf3fb;
    }

    .input-area {
      display: flex;
      gap: 10px;

      padding: 14px 20px;

      border-top:
        1px solid #dce2ea;

      background: #ffffff;
    }

    #questionInput {
      flex: 1;
      min-width: 0;

      padding: 13px 15px;

      border:
        1px solid #b9c3d0;

      border-radius: 9px;

      font: inherit;
      font-size: 15px;

      outline: none;
    }

    #questionInput:focus {
      border-color: #184782;

      box-shadow:
        0 0 0 2px
        rgba(24, 71, 130, 0.12);
    }

    #sendButton {
      padding: 0 22px;

      border: none;
      border-radius: 9px;

      background: #184782;
      color: #ffffff;

      font: inherit;
      font-weight: 700;

      cursor: pointer;
    }

    #sendButton:hover {
      background: #123866;
    }

    #sendButton:disabled {
      cursor: not-allowed;
      opacity: 0.5;
    }

    .notice {
      padding:
        0 18px 14px;

      background: #ffffff;
      color: #747d89;

      font-size: 11px;
      line-height: 1.6;
      text-align: center;
    }

    @media (
      max-width: 600px
    ) {
      .chat-header {
        padding: 18px 17px;
      }

      .chat-title {
        font-size: 22px;
      }

      .messages {
        padding: 16px;
      }

      .message {
        max-width: 92%;
        font-size: 14px;
      }

      .suggestions {
        padding:
          0 16px 12px;
      }

      .input-area {
        padding: 11px;
      }

      #sendButton {
        padding: 0 16px;
      }
    }
  </style>
</head>

<body>
  <main class="chat-container">

    <header class="chat-header">
      <h1 class="chat-title">
        NiSC チャットボット
      </h1>

      <p class="chat-subtitle">
        NiSCへの参加方法や、
        シンガポール留学について質問できます。
      </p>
    </header>

    <section
      id="messages"
      class="messages"
      aria-live="polite"
    >
      <div class="message-row bot-row">
        <div class="message bot-message">
こんにちは！NiSCのチャットボットです。

NiSCへの参加方法、シンガポールの大学、出願、寮、大学生活などについて質問してください。
        </div>
      </div>
    </section>

    <section class="suggestions">
      <p class="suggestions-title">
        質問例
      </p>

      <div class="suggestion-buttons">

        <button
          class="suggestion-button"
          type="button"
          data-question="NiSCにはどうやって参加できますか？"
        >
          NiSCへの参加方法
        </button>

        <button
          class="suggestion-button"
          type="button"
          data-question="交換留学生でも参加できますか？"
        >
          交換留学生の参加
        </button>

        <button
          class="suggestion-button"
          type="button"
          data-question="NUSの寮について教えてください"
        >
          NUSの寮
        </button>

        <button
          class="suggestion-button"
          type="button"
          data-question="英語力が心配です"
        >
          英語力について
        </button>

      </div>
    </section>

    <form
      id="chatForm"
      class="input-area"
    >
      <input
        id="questionInput"
        type="text"
        maxlength="1000"
        autocomplete="off"
        placeholder="質問を入力してください"
        aria-label="質問を入力してください"
        required
      >

      <button
        id="sendButton"
        type="submit"
      >
        送信
      </button>
    </form>

    <div class="notice">
      回答は参考情報です。
      入試・ビザ・学費などの最新情報は、
      大学や政府機関の公式サイトをご確認ください。
      個人情報は入力しないでください。
    </div>

  </main>

  <script>
    const form =
      document.getElementById(
        'chatForm'
      );

    const input =
      document.getElementById(
        'questionInput'
      );

    const sendButton =
      document.getElementById(
        'sendButton'
      );

    const messages =
      document.getElementById(
        'messages'
      );

    document
      .querySelectorAll(
        '.suggestion-button'
      )
      .forEach(function(button) {
        button.addEventListener(
          'click',
          function() {
            if (
              sendButton.disabled
            ) {
              return;
            }

            input.value =
              button.dataset.question ||
              '';

            sendQuestion();
          }
        );
      });

    form.addEventListener(
      'submit',
      function(event) {
        event.preventDefault();
        sendQuestion();
      }
    );

    async function sendQuestion() {
      const question =
        input.value.trim();

      if (
        !question ||
        sendButton.disabled
      ) {
        return;
      }

      addMessage(
        question,
        'user'
      );

      input.value = '';
      setLoading(true);

      const loadingMessage =
        addMessage(
          '回答を確認しています…',
          'loading'
        );

      try {
        const response =
          await fetch(
            '/api/chat',
            {
              method: 'POST',

              headers: {
                'Content-Type':
                  'application/json'
              },

              body:
                JSON.stringify({
                  question
                })
            }
          );

        const data =
          await response.json();

        loadingMessage.remove();

        addMessage(
          data.answer ||
            data.error ||
            '回答を取得できませんでした。',
          'bot'
        );

      } catch (error) {
        loadingMessage.remove();

        addMessage(
          'エラーが発生しました。時間をおいて、もう一度お試しください。',
          'bot'
        );

        console.error(error);

      } finally {
        setLoading(false);
        input.focus();
      }
    }

    function addMessage(
      text,
      type
    ) {
      const row =
        document.createElement(
          'div'
        );

      const message =
        document.createElement(
          'div'
        );

      if (type === 'user') {
        row.className =
          'message-row user-row';

        message.className =
          'message user-message';

      } else {
        row.className =
          'message-row bot-row';

        message.className =
          'message bot-message';

        if (
          type === 'loading'
        ) {
          message.classList.add(
            'loading-message'
          );
        }
      }

      message.textContent =
        text;

      row.appendChild(
        message
      );

      messages.appendChild(
        row
      );

      messages.scrollTop =
        messages.scrollHeight;

      return row;
    }

    function setLoading(
      isLoading
    ) {
      input.disabled =
        isLoading;

      sendButton.disabled =
        isLoading;

      sendButton.textContent =
        isLoading
          ? '送信中'
          : '送信';
    }
  </script>
</body>
</html>`;
}

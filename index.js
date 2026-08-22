const express = require('express');
const line = require('@line/bot-sdk');
const { createClient } = require('@supabase/supabase-js');

const app = express();

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

app.post('/webhook', line.middleware(config), async (req, res) => {
  const events = req.body.events;
  const client = new line.Client(config);

  for (let event of events) {
    if (event.type === 'message' && event.message.type === 'text') {
      const userText = event.message.text.trim().toUpperCase();

      // 「問題」または「NEXT」と送られた場合のみ新しい問題を出す
      if (userText === '問題' || userText === 'NEXT' || userText === 'スタート') {
        const { data, error } = await supabase
          .from('contents')
          .select('*')
          .limit(1);

        let replyText = "問題データの取得に失敗しました。";

        if (data && data.length > 0) {
          const q = data[0];
          // DBのカラム名がゆれていても取得できるようにフォールバックを設定
          const ans = q.answer || q.correct_answer || q.ans || "未設定";
          const exp = q.explanation || q.commentary || q.exp || q.rule_desc || "解説はありません。";

          replyText = `【${q.title || 'TOEIC問題'}】\n\n` +
                      `${q.stem}\n\n` +
                      `(A) ${q.choice_a}\n` +
                      `(B) ${q.choice_b}\n` +
                      `(C) ${q.choice_c}\n` +
                      `(D) ${q.choice_d}\n\n` +
                      `---------------\n` +
                      `【正解】${ans}\n\n` +
                      `【解説】\n${exp}`;
        }

        await client.replyMessage(event.replyToken, { type: 'text', text: replyText });
      } else {
        // A, B, C, D など他の文字が送られた時の案内メッセージ
        await client.replyMessage(event.replyToken, {
          type: 'text',
          text: `「${event.message.text}」を受け取りました。\n次の問題を解く場合は「問題」と送信してください！`
        });
      }
    }
  }
  res.status(200).end();
});

app.get('/health', (req, res) => res.send('OK'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

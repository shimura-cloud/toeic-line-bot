const express = require('express');
const line = require('@line/bot-sdk');
const { createClient } = require('@supabase/supabase-js');

const app = express();

// LINEの設定
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

// Supabaseの設定
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

// LINEからのメッセージを受け取るメイン処理
app.post('/webhook', line.middleware(config), async (req, res) => {
  const events = req.body.events;
  const client = new line.Client(config);

  for (let event of events) {
    if (event.type === 'message' && event.message.type === 'text') {      
      // Supabaseのcontentsテーブルからランダムに1問取得
      const { data, error } = await supabase
        .from('contents')
        .select('*')
        .limit(1);

      let replyText = "エラーが発生しました。";

      if (data && data.length > 0) {
        const q = data[0];
        replyText = `【${q.title}】\n\n${q.stem}\n\n(A) ${q.choice_a}\n(B) ${q.choice_b}\n(C) ${q.choice_c}\n(D) ${q.choice_d}`;
      }

      // LINEへ返信
      await client.replyMessage(event.replyToken, {
        type: 'text',
        text: replyText
      });
    }
  }
  res.status(200).end();
});

// 常時起動チェック（ヘルスチェック）用
app.get('/health', (req, res) => res.send('OK'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

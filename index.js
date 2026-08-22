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
      const { data, error } = await supabase
        .from('contents')
        .select('*')
        .limit(1);

      let replyText = "エラーが発生しました。";

      if (data && data.length > 0) {
        const q = data[0];
        replyText = `【${q.title || 'TOEIC問題'}】\n\n` +
                    `${q.stem}\n\n` +
                    `(A) ${q.choice_a}\n` +
                    `(B) ${q.choice_b}\n` +
                    `(C) ${q.choice_c}\n` +
                    `(D) ${q.choice_d}\n\n` +
                    `---------------\n` +
                    `【正解】${q.answer}\n\n` +
                    `【解説】\n${q.explanation || '解説はありません。'}`;
      }

      await client.replyMessage(event.replyToken, {
        type: 'text',
        text: replyText
      });
    }
  }
  res.status(200).end();
});

app.get('/health', (req, res) => res.send('OK'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

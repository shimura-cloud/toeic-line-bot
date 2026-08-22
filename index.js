const express = require('express');
const line = require('@line/bot-sdk');
const { createClient } = require('@supabase/supabase-js');

const app = express();

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

function getUserLevel(correctCount) {
  if (correctCount < 10) return { level: 1, title: "文法見習い 🐣", nextReq: 10 };
  if (correctCount < 30) return { level: 2, title: "Part5 チャレンジャー 🏃", nextReq: 30 };
  if (correctCount < 50) return { level: 3, title: "文法マスター 🎯", nextReq: 50 };
  return { level: 4, title: "Part5 覇者 👑", nextReq: null };
}

function getGenreQuickReply() {
  const genres = ["品詞識別", "動詞・時制", "代名詞", "接続詞・前置詞", "語彙・コロケーション", "分詞・関係詞・比較"];
  return {
    items: genres.map(g => ({
      type: 'action',
      action: { type: 'message', label: g, text: `【ジャンル】${g}` }
    }))
  };
}

app.post('/webhook', line.middleware(config), async (req, res) => {
  const events = req.body.events;
  const client = new line.Client(config);

  for (let event of events) {
    if (event.type === 'message' && event.message.type === 'text') {
      const userId = event.source.userId;
      const userText = event.message.text.trim();
      const userChoice = userText.toUpperCase();

      // 1. 解答処理（A, B, C, D）
      if (["A", "B", "C", "D"].includes(userChoice)) {
        // Supabaseのセッションテーブルから出題中の問題IDを取得
        const { data: sessionData } = await supabase
          .from('user_sessions')
          .select('current_content_id')
          .eq('user_id', userId);

        const contentId = sessionData && sessionData.length > 0 ? sessionData[0].current_content_id : null;

        if (!contentId) {
          await client.replyMessage(event.replyToken, {
            type: 'text',
            text: "出題中の問題がありません。「問題」と送信して挑戦してください！",
            quickReply: getGenreQuickReply()
          });
          continue;
        }

        // 問題データを取得
        const { data: resData } = await supabase
          .from('contents')
          .select('*')
          .eq('id', contentId);

        if (resData && resData.length > 0) {
          const q = resData[0];
          const rawCorrect = q.correct_choice || q.answer || '';
          const correctChoice = String(rawCorrect).trim().toUpperCase();
          const isCorrect = (userChoice === correctChoice);

          // ログ保存
          try {
            await supabase.from('user_logs').insert({
              user_id: userId,
              content_id: contentId,
              is_correct: isCorrect
            });
          } catch (err) {
            console.error("ログ保存エラー:", err);
          }

          // 出題中IDをクリア
          await supabase
            .from('user_sessions')
            .upsert({ user_id: userId, current_content_id: null, updated_at: new Date() });

          // 正解数・レベル計算
          const { data: logs } = await supabase
            .from('user_logs')
            .select('is_correct')
            .eq('user_id', userId);

          const totalCorrect = logs ? logs.filter(l => l.is_correct).length : 0;
          const lvlInfo = getUserLevel(totalCorrect);

          const resultMark = isCorrect ? "⭕ 正解！" : `❌ 不正解... (正解: ${correctChoice || '未設定'})`;
          const lvlMsg = lvlInfo.nextReq 
            ? `🏆 Lv.${lvlInfo.level} [${lvlInfo.title}] (次レベルまであと ${lvlInfo.nextReq - totalCorrect} 問正解)`
            : `🏆 Lv.${lvlInfo.level} [${lvlInfo.title}] (最高ランク到達！)`;

          const explanationText = `${resultMark}\n\n` +
            `${lvlMsg}\n` +
            `------------------------------\n` +
            `🧠 【ハマりポイント】\n${q.q_doubt || 'なし'}\n\n` +
            `💡 【解説】\n${q.ai_correct || q.explanation || q.rule_desc || '解説なし'}\n\n` +
            `⚠️ 【罠指摘】\n${q.ai_wrong || 'なし'}\n\n` +
            `🎯 【納得ワンポイント】\n${q.q_convinced || 'なし'}`;

          await client.replyMessage(event.replyToken, {
            type: 'text',
            text: explanationText,
            quickReply: getGenreQuickReply()
          });
        }
        continue;
      }

      // 2. ジャンル選択
      if (["ジャンル", "メニュー", "カテゴリ"].includes(userText)) {
        await client.replyMessage(event.replyToken, {
          type: 'text',
          text: "挑戦したい文法ジャンルを選択してください👇",
          quickReply: getGenreQuickReply()
        });
        continue;
      }

      // 3. マイページ
      if (userText === "マイページ") {
        try {
          const { data: logs } = await supabase
            .from('user_logs')
            .select('is_correct')
            .eq('user_id', userId);

          if (!logs || logs.length === 0) {
            await client.replyMessage(event.replyToken, {
              type: 'text',
              text: "まだ解答履歴がありません。「問題」または「ジャンル」と送って挑戦してみましょう！"
            });
          } else {
            const total = logs.length;
            const correctCount = logs.filter(l => l.is_correct).length;
            const accuracy = ((correctCount / total) * 100).toFixed(1);
            const lvlInfo = getUserLevel(correctCount);
            const nextStr = lvlInfo.nextReq ? `あと ${lvlInfo.nextReq - correctCount} 問正解でレベルアップ！` : "最高ランクに到達済みです！";

            const replyText = `👤 【あなたの学習ステータス】\n\n` +
              `🎖️ 称号: ${lvlInfo.title}\n` +
              `⭐ レベル: Lv.${lvlInfo.level}\n` +
              `🚀 進捗: ${nextStr}\n\n` +
              `------------------------------\n` +
              `📝 総解答数: ${total} 問\n` +
              `⭕ 正解数: ${correctCount} 問\n` +
              `🎯 全体正解率: ${accuracy} %\n\n` +
              `「ジャンル」から苦手分野を選んでどんどんレベルを上げましょう！`;

            await client.replyMessage(event.replyToken, { type: 'text', text: replyText });
          }
        } catch (e) {
          await client.replyMessage(event.replyToken, { type: 'text', text: "マイページデータの読み込みに失敗しました。" });
        }
        continue;
      }

      // 4. 出題処理
      let targetCategory = null;
      if (userText.startsWith("【ジャンル】")) {
        targetCategory = userText.replace("【ジャンル】", "");
      }

      if (userText === "問題" || targetCategory) {
        const { data: contentsRes } = await supabase.from('contents').select('*');

        if (!contentsRes || contentsRes.length === 0) {
          await client.replyMessage(event.replyToken, {
            type: 'text',
            text: "申し訳ありません。問題データがありません。"
          });
          continue;
        }

        let candidateQuestions = contentsRes;

        if (targetCategory) {
          try {
            const { data: rulesRes } = await supabase
              .from('rules')
              .select('rule_id, category')
              .eq('category', targetCategory);

            if (rulesRes && rulesRes.length > 0) {
              const targetRuleIds = rulesRes.map(r => r.rule_id ? r.rule_id.trim().toUpperCase() : '');
              const filtered = contentsRes.filter(q => q.rule_id && targetRuleIds.includes(q.rule_id.trim().toUpperCase()));
              if (filtered.length > 0) candidateQuestions = filtered;
            }
          } catch (catErr) {
            console.error("カテゴリ絞り込みエラー:", catErr);
          }
        }

        const q = candidateQuestions[Math.floor(Math.random() * candidateQuestions.length)];

        // DBのセッションテーブルに出題中の問題IDを保存
        await supabase
          .from('user_sessions')
          .upsert({ user_id: userId, current_content_id: q.id, updated_at: new Date() });

        const msg = `【TOEIC Part5】\n\n` +
          `${q.stem}\n\n` +
          `(A) ${q.choice_a}\n` +
          `(B) ${q.choice_b}\n` +
          `(C) ${q.choice_c}\n` +
          `(D) ${q.choice_d}`;

        const ansItems = ["A", "B", "C", "D"].map(opt => ({
          type: 'action',
          action: { type: 'message', label: opt, text: opt }
        }));

        await client.replyMessage(event.replyToken, {
          type: 'text',
          text: msg,
          quickReply: { items: ansItems }
        });
        continue;
      }

      // 5. デフォルト返信
      await client.replyMessage(event.replyToken, {
        type: 'text',
        text: `「問題」と送信するとTOEIC問題が出題されます！\n「マイページ」や「ジャンル」も試してみてください。`
      });
    }
  }
  res.status(200).end();
});

app.get('/health', (req, res) => res.send('OK'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

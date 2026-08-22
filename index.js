const express = require('express');
const line = require('@line/bot-sdk');
const { createClient } = require('@supabase/supabase-js');

const app = express();

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

// メモリ上でユーザーごとの出題中問題IDを保持
const userCurrentQ = {};

// --- レベル・称号判定ロジック ---
function getUserLevel(correctCount) {
  if (correctCount < 10) {
    return { level: 1, title: "文法見習い 🐣", nextReq: 10 };
  } else if (correctCount < 30) {
    return { level: 2, title: "Part5 チャレンジャー 🏃", nextReq: 30 };
  } else if (correctCount < 50) {
    return { level: 3, title: "文法マスター 🎯", nextReq: 50 };
  } else {
    return { level: 4, title: "Part5 覇者 👑", nextReq: null };
  }
}

// --- ジャンル選択用クイックリプライ ---
function getGenreQuickReply() {
  const genres = ["品詞識別", "動詞・時制", "代名詞", "接続詞・前置詞", "語彙・コロケーション", "分詞・関係詞・比較"];
  const items = genres.map(g => ({
    type: 'action',
    action: {
      type: 'message',
      label: g,
      text: `【ジャンル】${g}`
    }
  }));
  return { items };
}

app.post('/webhook', line.middleware(config), async (req, res) => {
  const events = req.body.events;
  const client = new line.Client(config);

  for (let event of events) {
    if (event.type === 'message' && event.message.type === 'text') {
      const userId = event.source.userId;
      const userText = event.message.text.trim();
      let userChoice = userText.toUpperCase();

      // 1. 解答処理（A, B, C, D ボタンを押した時）
      if (["A", "B", "C", "D"].includes(userChoice)) {
        const contentId = userCurrentQ[userId];

        if (contentId) {
          const { data: resData } = await supabase
            .from('contents')
            .select('*')
            .eq('id', contentId);

          if (resData && resData.length > 0) {
            const q = resData[0];
            const correctChoice = (q.correct_choice || q.answer || '').trim().toUpperCase();
            const isCorrect = (userChoice === correctChoice);

            // ログの保存
            try {
              await supabase.from('user_logs').insert({
                user_id: userId,
                content_id: contentId,
                is_correct: isCorrect
              });
            } catch (err) {
              console.error("ログ保存エラー:", err);
            }

            // 通算正解数の集計 & レベル計算
            const { data: logs } = await supabase
              .from('user_logs')
              .select('is_correct')
              .eq('user_id', userId);

            const totalCorrect = logs ? logs.filter(l => l.is_correct).length : 0;
            const lvlInfo = getUserLevel(totalCorrect);

            const resultMark = isCorrect ? "⭕ 正解！" : `❌ 不正解... (正解: ${correctChoice})`;
            let lvlMsg = "";
            if (lvlInfo.nextReq) {
              const remain = lvlInfo.nextReq - totalCorrect;
              lvlMsg = `🏆 Lv.${lvlInfo.level} [${lvlInfo.title}] (次レベルまであと ${remain} 問正解)`;
            } else {
              lvlMsg = `🏆 Lv.${lvlInfo.level} [${lvlInfo.title}] (最高ランク到達！)`;
            }

            // 詳細な解説メッセージの構築
            const explanationText = `${resultMark}\n\n` +
              `${lvlMsg}\n` +
              `------------------------------\n` +
              `🧠 【ハマりポイント】\n${q.q_doubt || 'なし'}\n\n` +
              `💡 【解説】\n${q.ai_correct || q.explanation || '解説なし'}\n\n` +
              `⚠️ 【罠指摘】\n${q.ai_wrong || 'なし'}\n\n` +
              `🎯 【納得ワンポイント】\n${q.q_convinced || 'なし'}`;

            delete userCurrentQ[userId];

            await client.replyMessage(event.replyToken, {
              type: 'text',
              text: explanationText,
              quickReply: getGenreQuickReply()
            });
            continue;
          }
        }
      }

      // 2. ジャンル・メニュー選択
      if (["ジャンル", "メニュー", "カテゴリ"].includes(userText)) {
        await client.replyMessage(event.replyToken, {
          type: 'text',
          text: "挑戦したい文法ジャンルを選択してください👇",
          quickReply: getGenreQuickReply()
        });
        continue;
      }

      // 3. マイページ機能
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

      // 4. 出題処理（「問題」または「【ジャンル】〇〇」）
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

        // カテゴリ指定がある場合の絞り込み
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

        // ランダムに1問選択
        const q = candidateQuestions[Math.floor(Math.random() * candidateQuestions.length)];
        userCurrentQ[userId] = q.id;

        const msg = `【TOEIC Part5】\n\n` +
          `${q.stem}\n\n` +
          `(A) ${q.choice_a}\n` +
          `(B) ${q.choice_b}\n` +
          `(C) ${q.choice_c}\n` +
          `(D) ${q.choice_d}`;

        // 解答用 A/B/C/D ボタン（クイックリプライ）
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

      // 上記のいずれにも該当しないデフォルト返信
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

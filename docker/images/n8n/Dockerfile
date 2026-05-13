{
  "nodes": [
    {
      "parameters": {
        "model": "gemini-1.5-flash",
        "messages": {
          "message": [
            {
              "role": "user",
              "content": "=أنت خبير تسويق جزائري محترف. خذ هذه البيانات لمنتج من AliExpress واكتب منشور تليجرام جذاب جداً باللهجة الجزائرية (تاع همزات وشوبينغ). استخدم الإيموجي واجعل الرابط واضحاً.\n\nالمنتج: {{ $json.product_name }}\nالرابط: {{ $json.link }}"
            }
          ]
        },
        "options": {}
      },
      "id": "1",
      "name": "Gemini AI Optimizer",
      "type": "n8n-nodes-base.googleGemini",
      "typeVersion": 1,
      "position": [800, 300]
    },
    {
      "parameters": {
        "chatId": "YOUR_CHAT_ID",
        "text": "={{ $node[\"Gemini AI Optimizer\"].json[\"text\"] }}",
        "additionalFields": {}
      },
      "id": "2",
      "name": "Telegram Bot Post",
      "type": "n8n-nodes-base.telegram",
      "typeVersion": 1,
      "position": [1050, 300]
    }
  ],
  "connections": {
    "Gemini AI Optimizer": {
      "main": [
        [
          {
            "node": "Telegram Bot Post",
            "type": "main",
            "index": 0
          }
        ]
      ]
    }
  }
}

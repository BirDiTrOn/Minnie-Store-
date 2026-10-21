export default {
  "version": 1,
  "settings": {
    "storeName": "Minnie Store",
    "telegram": "Lisaa_lisaz",
    "openHour": 7,
    "closeHour": 23,
    "khrRate": 4100,
    "khqrImage": "/assets/khqr.jpg",
    "qrAccountName": "SIV NANN"
  },
  "games": [
    {
      "id": "rbx-login",
      "name": "Robux (Login)",
      "tag": "Login",
      "sub": "We top up through your Roblox account.",
      "note": "Login details are shared privately on Telegram after payment, never on this page.",
      "color": "#e0332b",
      "icon": "/assets/robux.png",
      "glyph": "R$",
      "hidden": false,
      "soldOut": false,
      "fields": [
        {
          "key": "user",
          "label": "Roblox username"
        }
      ],
      "packs": [
        {
          "name": "80 Robux",
          "usd": 1.0,
          "khr": 4100
        },
        {
          "name": "160 Robux",
          "usd": 1.9,
          "khr": 7800
        },
        {
          "name": "240 Robux",
          "usd": 3.0,
          "khr": 12300
        },
        {
          "name": "320 Robux",
          "usd": 3.8,
          "khr": 15500
        },
        {
          "name": "500 Robux",
          "usd": 4.8,
          "khr": 19700
        },
        {
          "name": "660 Robux",
          "usd": 6.6,
          "khr": 27000
        },
        {
          "name": "740 Robux",
          "usd": 7.4,
          "khr": 30300
        },
        {
          "name": "1,000 Robux",
          "usd": 9.4,
          "khr": 38500
        },
        {
          "name": "1,500 Robux",
          "usd": 14.0,
          "khr": 57400
        },
        {
          "name": "2,000 Robux",
          "usd": 18.0,
          "khr": 73800
        },
        {
          "name": "2,500 Robux",
          "usd": 22.5,
          "khr": 92200
        },
        {
          "name": "3,000 Robux",
          "usd": 27.0,
          "khr": 110700
        },
        {
          "name": "5,000 Robux",
          "usd": 46.0,
          "khr": 188600
        },
        {
          "name": "10,000 Robux",
          "usd": 90.0,
          "khr": 369000
        }
      ]
    },
    {
      "id": "rbx-send",
      "name": "Robux (Send)",
      "tag": "Send",
      "sub": "No password needed. You buy a game pass we set up for you.",
      "note": "We send you a game pass link on Telegram after payment.",
      "color": "#c4580a",
      "icon": "/assets/robux.png",
      "glyph": "R$",
      "hidden": false,
      "soldOut": false,
      "fields": [
        {
          "key": "user",
          "label": "Roblox username"
        }
      ],
      "packs": [
        {
          "name": "100 Robux",
          "usd": 1.0
        },
        {
          "name": "200 Robux",
          "usd": 2.0
        },
        {
          "name": "500 Robux",
          "usd": 5.0
        }
      ]
    }
  ]
};

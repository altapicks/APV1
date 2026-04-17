# DeuceData Tennis Optimizer

React app for DraftKings Tennis DFS projections and lineup optimization, with PrizePicks EV comparison.

## Deploy to Vercel (Free)

### Step 1: Push to GitHub
1. Create a private repo on GitHub
2. Push all files in this folder to the repo

### Step 2: Deploy on Vercel
1. Go to [vercel.com](https://vercel.com) → sign in with GitHub
2. Import your repo → Vercel auto-detects Vite/React
3. Click Deploy → get a URL like `deucedata.vercel.app`

### Step 3: Share
Send the URL to anyone. Works on phone, laptop, anything.

---

## Admin Workflow (You)

### Daily Update Process
1. Edit `public/data/slate.json` with today's data
2. Push to GitHub → Vercel auto-deploys in ~30 seconds
3. Users see the updated slate immediately

### Data File: `public/data/slate.json`

This single JSON file contains everything for the day's slate:

```json
{
  "date": "2026-04-16",
  "matches": [
    {
      "player_a": "Arthur Fils",
      "player_b": "Brandon Nakashima",
      "start_time": "2026-04-16T13:30:00-06:00",
      "tournament": "ATP Barcelona",
      "odds": {
        "ml_a": -350,       // Money line Player A
        "ml_b": 275,        // Money line Player B
        "set_a_20": -120,   // Player A wins 2-0
        "set_a_21": 240,    // Player A wins 2-1
        "set_b_20": 600,    // Player B wins 2-0
        "set_b_21": 550,    // Player B wins 2-1
        "gw_a_line": 12.5,  // Games won line
        "gw_a_over": -150,  // Over odds
        "gw_b_line": 10.5,
        "gw_b_over": -120,
        "brk_a_line": 2.5,  // Breaks of serve
        "brk_a_over": -200,
        "brk_b_line": 1.5,
        "brk_b_over": -120,
        "ace_a_5plus": -200, // 5+ aces odds
        "ace_a_10plus": 400, // 10+ aces odds
        "ace_b_5plus": -225,
        "ace_b_10plus": 333,
        "df_a_2plus": -275,  // 2+ double faults
        "df_a_3plus": 100,   // 3+ double faults
        "df_b_2plus": 100,
        "df_b_3plus": 300
      },
      "adj_a": 0,   // Your read: +/- projection adjustment
      "adj_b": 0
    }
  ],
  "dk_players": [
    { "name": "Arthur Fils", "id": 42662152, "salary": 9200, "avg_ppg": 55.16 }
  ],
  "pp_lines": [
    { "player": "Arthur Fils", "stat": "Fantasy Score", "line": 28.5 },
    { "player": "Arthur Fils", "stat": "Games Won", "line": 11.5 },
    { "player": "Arthur Fils", "stat": "Aces", "line": 4.5 }
  ]
}
```

### Supported PP Stats
- `Fantasy Score` → compared against PP scoring model
- `Games Won` → compared against projected games won
- `Aces` → compared against projected aces
- `Total Games` → compared against projected GW + GL
- `Double Faults` → compared against projected DFs
- `Sets Won` → compared against projected sets won
- `Breaks` → compared against projected breaks

### Quick Odds Entry Tips
- All odds in American format (e.g., -150, +275)
- Get all odds from bet365 match page
- `adj_a` / `adj_b`: Your read in points. +3 = "wins in straights", -3 = "wins in 3 sets"
- Start times in ISO format with timezone offset

---

## Scoring

### DK Classic Tennis (Best of 3)
Match Played +30 | Match Won +6 | Set W/L +6/-3 | Game W/L +2.5/-2
Ace +0.4 | DF -1 | Break +0.75
Straight Sets +6 | Clean Set +4 | No DF +2.5 | 10+ Aces +2

### PrizePicks Tennis
Match Played +10 | Game W/L +1/-1 | Set W/L +3/-3
Ace +0.5 | DF -0.5

---

## Local Development

```bash
npm install
npm run dev
```

Opens at `http://localhost:5173`

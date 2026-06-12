# Ruralift CRM

## Start (first time)
```bash
npm install
npm start
```

## Access from other devices on the same Wi-Fi / LAN
When the server starts it prints every LAN IP, e.g.:
```
  LAN:  http://192.168.1.10:3000   <-- use this on other devices
```
Open that address on any phone, tablet, or PC on the same network.

**Windows Firewall:** Allow "Node.js" for Private networks if other devices can't connect.

## Printing tips
- Open a customer → Print Receipt  or  Print Agreement + PDC
- In the browser print dialog: Paper = A4, Orientation = Portrait
- Disable "Headers and Footers" in print settings for the cleanest output
- Margins are handled by the page CSS — set browser margin to "Default" or "None"

## Files included
| File | Purpose |
|------|---------|
| `Ruralift_Consultation_Fee_Receipt.docx` | Fixed consultation fee receipt (proper tables, print-ready) |
| `Kiro_Agreement.docx` | Fixed loan agreement (proper tables, print-ready) |
| `server.js` | Node.js backend, saves to state.json |
| `public/index.html` | CRM frontend + print templates |
| `state.json` | Customer data — back this up regularly |

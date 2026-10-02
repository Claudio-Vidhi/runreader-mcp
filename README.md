# RunReader MCP

Il server personale che collega l'app **RunReader** a **Claude**: Claude legge i
riepiloghi delle tue attività e scrive piani e consigli che vedi nell'app.
Ognuno crea il proprio server nel proprio account Cloudflare (gratis): i tuoi
dati non passano da nessun altro.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Claudio-Vidhi/runreader-mcp)

## Dal telefono, in 3 passi

1. In RunReader apri **Profilo › Impostazioni › Claude**: l'app ti mostra due
   codici, `APP_TOKEN` e `ACCESS_CODE`, e il pulsante **Apri Cloudflare**.
2. Nel modulo di Cloudflare (servono un account Cloudflare e uno GitHub,
   gratuiti) incolla i due codici e tocca **Deploy**. Alla fine copia
   l'indirizzo `https://runreader-mcp.<tuo-nome>.workers.dev` in RunReader e tocca
   **Verifica e collega**.
3. Su [claude.ai](https://claude.ai/settings/connectors), dal browser (non
   dall'app Claude), aggiungi un connettore personalizzato con l'indirizzo che
   finisce in `/mcp` e accedi con il codice di accesso. Il connettore funziona
   poi anche nell'app Claude. Il piano gratuito di Claude permette un connettore
   personalizzato.

## Cosa riceve il server

Solo riepiloghi: data, tipo, km, tempi, passo, FC media e massima, frazioni al
km, tratti migliori. **Mai** la traccia GPS né i battiti secondo per secondo.
Puoi cancellare tutto dall'app (**Cancella dal server**).

---

# RunReader MCP (English)

Your personal server linking the **RunReader** app to **Claude**: Claude reads
your activity summaries and writes plans and tips you see in the app. Everyone
creates their own server in their own free Cloudflare account; your data goes
through nobody else.

From the phone: open **Profile › Settings › Claude** in RunReader, copy the two
codes into the Cloudflare form, tap **Deploy**, paste the `workers.dev` address
back into the app, then add a custom connector on claude.ai (in the browser)
with the address ending in `/mcp` and the access code.

Only summaries are stored: never GPS tracks or per-second heart rate.

## From a computer

```sh
npm install
npx wrangler deploy                       # creates the D1 database and KV namespace
npx wrangler secret put APP_TOKEN
npx wrangler secret put ACCESS_CODE
```

Tables are created by the server on its first request.

# Download server

Lokální server pro doplněk. Běží ve WSL, stahuje do Windows složky `Downloads` a doplňku hlásí průběh:

- **Libovolné video přes `yt-dlp`** (YouTube, Vimeo, …) – první sekce vyskakovacího okna po kliku na ikonu
  doplňku (URL se předvyplní z aktuální záložky). Kvalita max. Full HD, jinak nejlepší nižší (720p…),
  preferuje mp4. Název souboru `DATUM NÁZEV.ext` (datum nahrání videa, když chybí, tak dnešní), viz `ytdlp.js`.
- **HLS (m3u8) videa** přes `ffmpeg` – tlačítko „⬇ Download“ v DevTools panelu „Videos“.
- **Soubory z veřejné složky Google Drive** (vč. podsložek) podle koncovky, např. `.gpx, .gp` –
  druhá sekce vyskakovacího okna. Složka musí být sdílená „kdokoli s odkazem“; seznam souborů
  se čte z HTML stránky složky (bez API klíče), viz `drive.js`.

## Spuštění

```sh
sudo apt install ffmpeg   # pokud chybí
pipx install yt-dlp       # pokud chybí
pipx inject yt-dlp yt-dlp-ejs   # řešení JS výzev YouTube (jinak můžou chybět formáty), viz https://github.com/yt-dlp/yt-dlp/wiki/EJS
npm run server
```

Složka pro stažení se zjistí automaticky (`%USERPROFILE%\Downloads` → `/mnt/c/Users/<uživatel>/Downloads`).

## Konfigurace (env)

| Proměnná         | Výchozí            | Popis                                                        |
|------------------|--------------------|--------------------------------------------------------------|
| `PORT`           | `9787`             | Port (doplněk volá `http://localhost:9787`, viz `SERVER_URL` v `panel.js`) |
| `HOST`           | `127.0.0.1`        | Adresa, na které server poslouchá                            |
| `DOWNLOAD_DIR`   | Windows Downloads  | Cílová složka                                                |
| `MAX_CONCURRENT` | `3`                | Max. počet souběžných stahování, další čekají ve frontě      |
| `EXTENSION_IDS`  | –                  | ID doplňků (oddělená čárkou), které smí server volat; jinak jakýkoliv `chrome-extension://` |
| `FFMPEG`         | `ffmpeg`           | Cesta k ffmpeg                                               |
| `YTDLP`          | `yt-dlp`           | Cesta k yt-dlp                                               |
| `YTDLP_FORMAT_SORT` | `res:1080,ext`  | Řazení formátů yt-dlp (`-S`), např. `res:720,ext`            |
| `YTDLP_JS_RUNTIME` | Node.js serveru  | JS runtime pro yt-dlp (`--js-runtimes`), např. `deno`; prázdná hodnota = výchozí yt-dlp |
| `YTDLP_COOKIES`  | –                  | Cesta k `cookies.txt` pro yt-dlp (věkově omezená videa apod.) |

## API

- `GET /health` – stav serveru
- `GET /downloads` – seznam stahování (nejnovější první)
- `POST /downloads` `{ url, title, headers }` – spustí stahování; `headers` (referer, cookie, user-agent, …) se předají ffmpeg
- `POST /ytdlp` `{ url }` – zjistí info o videu (`yt-dlp -J`) a stáhne ho; playlisty nepodporuje
- `POST /drive` `{ url, extensions }` – najde ve složce Google Drive (i v podsložkách) soubory s danými koncovkami a stáhne je
- `DELETE /downloads` – vyčistí seznam (odebere dokončená/chybná/zrušená stahování, soubory zůstávají)
- `DELETE /downloads/:id` – zruší běžící stahování, u dokončeného jen odebere záznam ze seznamu (soubor zůstává)

Požadavky s `Origin` jiné stránky než doplňku server odmítá, aby stahování nemohl spustit libovolný web.

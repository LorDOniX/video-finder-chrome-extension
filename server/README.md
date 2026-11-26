# Download server

Lokální server pro doplněk. Běží ve WSL, stahuje do Windows složky `Downloads` a doplňku hlásí průběh:

- **HLS (m3u8) videa** přes `ffmpeg` – tlačítko „⬇ Download“ v DevTools panelu „Videos“.
- **Soubory z veřejné složky Google Drive** (vč. podsložek) podle koncovky, např. `.gpx, .gp` –
  vyskakovací okno po kliku na ikonu doplňku. Složka musí být sdílená „kdokoli s odkazem“; seznam souborů
  se čte z HTML stránky složky (bez API klíče), viz `drive.js`.

## Spuštění

```sh
sudo apt install ffmpeg   # pokud chybí
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

## API

- `GET /health` – stav serveru
- `GET /downloads` – seznam stahování (nejnovější první)
- `POST /downloads` `{ url, title, headers }` – spustí stahování; `headers` (referer, cookie, user-agent, …) se předají ffmpeg
- `POST /drive` `{ url, extensions }` – najde ve složce Google Drive (i v podsložkách) soubory s danými koncovkami a stáhne je
- `DELETE /downloads` – vyčistí seznam (odebere dokončená/chybná/zrušená stahování, soubory zůstávají)
- `DELETE /downloads/:id` – zruší běžící stahování, u dokončeného jen odebere záznam ze seznamu (soubor zůstává)

Požadavky s `Origin` jiné stránky než doplňku server odmítá, aby stahování nemohl spustit libovolný web.

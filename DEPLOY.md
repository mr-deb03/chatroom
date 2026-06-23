# Deploying ChatRoom to Render (free)

This app is a **custom Node server + WebSockets**, so it must run as a Render
**Web Service** (not a static site, and not Vercel/Netlify). A `render.yaml`
blueprint is included so Render configures everything automatically.

## Step 1 — Put the code on GitHub

A git repo and first commit already exist locally. Create an **empty** GitHub repo
(no README / .gitignore / license) named `chatroom`, then push:

```bash
git remote add origin https://github.com/<your-username>/chatroom.git
git push -u origin main
```

> First push may open a browser to log in to GitHub — that's the credential manager.

## Step 2 — Create the Render service from the blueprint

1. Go to **https://dashboard.render.com** and sign up / log in (you can "Sign in with GitHub").
2. Click **New +** → **Blueprint**.
3. Connect your GitHub and pick the **chatroom** repo.
4. Render reads `render.yaml` and shows a web service named **chatroom** on the **Free** plan.
5. Click **Apply** / **Create**.
6. Wait ~3–5 minutes for the first build (`npm install && npm run build`) and deploy.

You'll get a public URL like **https://chatroom-xxxx.onrender.com**. Share it —
anyone can open it, set a profile, and join your room with the code. 🎉

Because Render serves the site over **HTTPS**, **voice notes and the camera work**
for everyone (they're blocked on plain `http://` LAN addresses).

## Make chats permanent with MongoDB Atlas (free)

By default the app stores chats in a local file that **Render wipes on every restart**
(that's why rooms/chats disappear). Point it at a free MongoDB Atlas database and
rooms, messages, and uploaded images/voice (stored in GridFS) **persist forever** —
until someone deletes them.

1. Go to **https://www.mongodb.com/cloud/atlas/register** and sign up (free).
2. Create a **free M0 cluster** (pick any cloud/region near you). Wait ~1–3 min.
3. **Database Access** → **Add New Database User** → username + password (save them).
4. **Network Access** → **Add IP Address** → **Allow access from anywhere** (`0.0.0.0/0`).
   (Render's IPs aren't fixed on the free plan, so this is the simple option.)
5. **Database** → **Connect** → **Drivers** → copy the connection string. It looks like:
   ```
   mongodb+srv://<user>:<password>@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority
   ```
   Replace `<user>` and `<password>` with the ones from step 3.
6. In **Render** → your service → **Environment** → **Add Environment Variable**:
   - **Key:** `MONGODB_URI`  **Value:** the connection string from step 5.
   - Save. Render redeploys automatically.

On boot the logs will show `Storage: MongoDB (… rooms loaded)`. Done — chats are durable.
(Optional: set `MONGODB_DB` to change the database name; default is `chatroom`.)

## Things to know about the free tier

- **Cold starts:** the service sleeps after ~15 min idle. The next visit takes
  ~30–50s to wake up, then it's fast again.
- **Without `MONGODB_URI`:** chat history and uploaded media are erased on every
  redeploy / recycle. With it (above), everything persists.

## Updating the live app later

```bash
git add -A
git commit -m "your change"
git push
```

Render auto-deploys on every push to `main`.
```

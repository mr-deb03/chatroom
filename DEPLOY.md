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

## Things to know about the free tier

- **Cold starts:** the service sleeps after ~15 min idle. The next visit takes
  ~30–50s to wake up, then it's fast again.
- **Storage is temporary:** chat history (`data.json`) and uploaded images / voice
  notes are erased on every redeploy and whenever the free instance recycles.
  Fine for casual chatting. To keep history permanently you'd:
  - upgrade to a paid instance and attach a **Disk**, mounted at the uploads/data path, **or**
  - store media in a service like Cloudinary/S3 and messages in a database (Postgres/Redis).

## Updating the live app later

```bash
git add -A
git commit -m "your change"
git push
```

Render auto-deploys on every push to `main`.
```

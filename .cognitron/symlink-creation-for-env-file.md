Updated todo list

I'll create a symbolic link from `portowa.env` to `.env` for you, and explain the process. 

Ran terminal command:  ln -s portowa.env .env && ls -la | grep -E '\.env|portowa'

Perfect! The symbolic link is now created. Here's what you need to know:

## What I did
Created a symbolic link named `.env` that points to `portowa.env`. When your application reads `.env`, it actually reads the content of `portowa.env`.

## How to create a symbolic link
**On macOS/Linux:**
```bash
ln -s <target-file> <link-name>
```
Example:
```bash
ln -s portowa.env .env
```

- `-s` flag makes it a *symbolic* link (a reference, not a copy)
- First argument: the file you want to link *from* (the actual file)
- Second argument: the name of the link to create

## How to remove a symbolic link
```bash
rm .env
```

Simply use `rm` on the link name. **Important:** This deletes only the link, not the original file (`portowa.env` stays intact).

## Verify it works
```bash
cat .env           # Reads portowa.env content
ls -la | grep env  # Shows `.env -> portowa.env` indicating it's a link
file .env          # Shows it's a symbolic link
```

Your `.env` is now ready to use, and any tool looking for environment variables in `.env` will find them from `portowa.env`.

Created 2 todos
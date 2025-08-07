# 🧠 Task
(What do you want the code to do? Write a short, clear description.)

Example:
Create a Python script to scrape article headlines from a website and save them in a CSV file.

---

# 🧱 Requirements
(What technologies, packages, or approaches should be used?)

Example:
- Use Python 3.10+
- Use `requests` and `BeautifulSoup`
- Target website: https://example.com/news
- Save output as a local CSV file

---

# 🚧 Constraints
(What must the code avoid or comply with?)

Example:
- Handle pagination
- Avoid duplicate entries
- Do not use Selenium or headless browsers
- Under 150 lines of code if possible

---

# 📦 Input
(If the script takes input, describe it here.)

Example:
- URL of the main news page (as a command-line argument)
- Optional `--max-pages` parameter

---

# 📤 Output
(Describe expected outputs: files, printed results, etc.)

Example:
- A CSV file named `headlines.csv` with columns: `Title`, `Link`, `Date`

---

# 📝 Notes
(Anything ChatGPT should be aware of? Site behavior, special rules, etc.)

Example:
- The target website is static HTML.
- Each news item is inside a `<div class="news-item">` block.

---

# 🧪 Testing / Verification
(How will you check if the code works?)

Example:
- Run script with: `python scraper.py https://example.com/news`
- Confirm CSV is created with correct data

import 'dotenv/config';

const API_KEY = process.env.HEVY_API_KEY ?? '';
const BASE = 'https://api.hevyapp.com/v1/exercise_templates';

async function main() {
  let page = 1;
  let pageCount = 1;
  const all: string[] = [];

  while (page <= pageCount) {
    const res = await fetch(`${BASE}?page=${page}&pageSize=100`, {
      headers: { 'api-key': API_KEY },
    });
    const data = await res.json();
    pageCount = data.page_count;
    all.push(...data.exercise_templates.map((t: any) => t.title));
    page++;
  }

  // Print matches for the failing pins
  const terms = ['tricep', 'push.?down', 'pull.?up', 'knee raise',
                 'leg raise', 'lunge', 'leg curl', 'incline chest'];
  for (const term of terms) {
    const re = new RegExp(term, 'i');
    const matches = all.filter(t => re.test(t));
    console.log(`\n${term}:`, matches.length ? matches : '(none)');
  }
}

main();

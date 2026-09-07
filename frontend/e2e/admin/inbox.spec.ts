import { test, expect } from '@playwright/test';
import { API_PREFIX } from '../config';

/**
 * Admin Inbox (#69) in a real browser — the receiving half of the recruiter
 * flow. Unit tests cover the component; this covers the composed admin app:
 * routing, the filter round trip, expand-to-read, the inline status control,
 * and the promote hand-off into the pipeline (#247).
 */
const INTERACTION = {
    id: 'ix-1',
    source: 'contact_form',
    status: 'new',
    name: 'Rita Recruiter',
    email: 'rita@agency.example',
    company: 'Agency GmbH',
    message: 'We have a Staff Engineer role that fits your profile.',
    payload: null,
    created_at: '2026-09-06T09:00:00Z',
    updated_at: '2026-09-06T09:00:00Z',
};

const page1 = (items: unknown[]) => ({ items, total: items.length, page: 1, pages: 1 });

test.describe('Admin Inbox', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/login');
        await page.fill('input[name="username"]', 'admin');
        await page.fill('input[name="password"]', 'admin123');
        await page.click('button[type="submit"]');
        await expect(page).toHaveURL(/\/dashboard/);
    });

    test('shows the empty state on a fresh deployment', async ({ page }) => {
        await page.route(`**${API_PREFIX}/admin/interactions*`, (route) =>
            route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(page1([])) })
        );
        await page.goto('/inbox');
        await expect(page.getByRole('heading', { name: 'Inbox' })).toBeVisible();
        await expect(page.getByText(/No interactions yet/)).toBeVisible();
    });

    test('lists interactions, expands the message, and filters by status', async ({ page }) => {
        const seen: string[] = [];
        await page.route(`**${API_PREFIX}/admin/interactions*`, (route) => {
            seen.push(route.request().url());
            route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(page1([INTERACTION])) });
        });

        await page.goto('/inbox');
        await expect(page.getByTestId('row-ix-1')).toBeVisible();
        await expect(page.getByText('rita@agency.example')).toBeVisible();

        // The message body is behind the expand interaction, not in the row.
        await expect(page.getByText(/Staff Engineer role/)).toHaveCount(0);
        await page.getByTestId('row-ix-1').click();
        await expect(page.getByText(/Staff Engineer role/)).toBeVisible();

        // Filtering re-queries the API with the chosen status.
        await page.getByLabel('filter by status').selectOption('contacted');
        await expect.poll(() => seen.some((u) => u.includes('status=contacted'))).toBe(true);
    });

    test('changes a status inline through the API', async ({ page }) => {
        let patched: Record<string, unknown> | null = null;
        await page.route(`**${API_PREFIX}/admin/interactions*`, (route) =>
            route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(page1([INTERACTION])) })
        );
        // Separate pattern on purpose: a glob `*` does NOT cross `/`, so the
        // list route above never matches `/admin/interactions/{id}` — without
        // this the PATCH would escape to the real backend and the assertion
        // would silently observe nothing (caught by running the spec).
        await page.route(`**${API_PREFIX}/admin/interactions/*`, (route) => {
            patched = route.request().postDataJSON();
            return route.fulfill({
                status: 200, contentType: 'application/json',
                body: JSON.stringify({ ...INTERACTION, status: 'contacted' }),
            });
        });

        await page.goto('/inbox');
        await page.getByLabel('status of Rita Recruiter').selectOption('contacted');
        await expect.poll(() => patched).toMatchObject({ status: 'contacted' });
    });

    test('promotes an interaction into the pipeline', async ({ page }) => {
        let promoted: Record<string, unknown> | null = null;
        await page.route(`**${API_PREFIX}/admin/interactions*`, (route) =>
            route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(page1([INTERACTION])) })
        );
        await page.route(`**${API_PREFIX}/admin/opportunities/promote`, (route) => {
            promoted = route.request().postDataJSON();
            return route.fulfill({
                status: 201, contentType: 'application/json',
                body: JSON.stringify({
                    id: 'op-1', company: 'Agency GmbH', role_title: 'Unknown role',
                    stage: 'lead', source: 'recruiter_outreach', recruiter_name: 'Rita Recruiter',
                    recruiter_email: 'rita@agency.example', link: null, salary_note: null,
                    next_action: null, next_action_date: null, notes: [],
                    created_at: '2026-09-06T09:05:00Z', updated_at: '2026-09-06T09:05:00Z',
                }),
            });
        });

        await page.goto('/inbox');
        await page.getByTestId('row-ix-1').click();
        await page.getByLabel('promote Rita Recruiter to pipeline').click();
        await expect.poll(() => promoted).toMatchObject({ interaction_id: 'ix-1' });
    });

    test('paginates when the inbox holds more than one page', async ({ page }) => {
        const seen: string[] = [];
        const rows = (page_: number) => ({
            items: [{ ...INTERACTION, id: `ix-p${page_}`, name: `Rita Page ${page_}` }],
            total: 3,
            page: page_,
            pages: 3,
        });
        await page.route(`**${API_PREFIX}/admin/interactions*`, (route) => {
            const url = new URL(route.request().url());
            seen.push(url.search);
            const p = Number(url.searchParams.get('page') ?? '1');
            return route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify(rows(p)),
            });
        });

        await page.goto('/inbox');
        await expect(page.getByTestId('row-ix-p1')).toBeVisible();
        // Prev is disabled on page 1 — you cannot walk off the front.
        await expect(page.getByRole('button', { name: 'Prev' })).toBeDisabled();

        await page.getByRole('button', { name: 'Next' }).click();
        await expect(page.getByTestId('row-ix-p2')).toBeVisible();
        await expect(page.getByRole('button', { name: 'Prev' })).toBeEnabled();
        expect(seen.some((q) => q.includes('page=2'))).toBe(true);

        // ...and back, so the control is not one-way.
        await page.getByRole('button', { name: 'Prev' }).click();
        await expect(page.getByTestId('row-ix-p1')).toBeVisible();
    });

    test('surfaces a load failure instead of showing a misleading empty inbox', async ({ page }) => {
        await page.route(`**${API_PREFIX}/admin/interactions*`, (route) =>
            route.fulfill({ status: 500, contentType: 'application/json', body: '{"detail":"boom"}' })
        );
        await page.goto('/inbox');
        const alert = page.locator('[role="alert"]').first();
        await expect(alert).toBeVisible();
        await expect(alert).toContainText(/fail|error|load/i);
        // The empty-state copy must NOT appear on an error — "no messages" and
        // "we could not load your messages" mean very different things.
        await expect(page.getByText(/No interactions yet/)).toHaveCount(0);
    });

    test('transparent translation: label, toggle to original, re-translate (#248)', async ({ page }) => {
        const TRANSLATED = {
            ...INTERACTION,
            message: 'Hallo, sind Sie offen für eine neue Stelle?',
            detected_language: 'de',
            translated_message: 'Hello, are you open to a new role?',
            translated_to: 'en',
            translation_status: 'done',
        };
        // Separate route: a single `*` does not cross `/` in Playwright
        // globs, so the deep /{id}/translate path needs its own pattern.
        await page.route(`**${API_PREFIX}/admin/interactions/*/translate`, (route) =>
            route.fulfill({
                status: 200, contentType: 'application/json',
                body: JSON.stringify({ ...TRANSLATED, translated_message: 'Hello — open to a new role?' }),
            })
        );
        await page.route(`**${API_PREFIX}/admin/interactions*`, (route) =>
            route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(page1([TRANSLATED])) })
        );

        await page.goto('/inbox');
        await page.getByText(TRANSLATED.name).click();

        // Machine translation shown, clearly labeled; original NOT silently replaced.
        const text = page.getByTestId('message-text');
        await expect(text).toContainText('Hello, are you open to a new role?');
        await expect(page.getByTestId('translation-bar')).toContainText('machine-translated to en');

        // The original is one click away, intact.
        await page.getByRole('button', { name: /toggle original/ }).click();
        await expect(text).toContainText('Hallo, sind Sie offen für eine neue Stelle?');
        await page.getByRole('button', { name: /toggle original/ }).click();

        // Re-translate round-trips and repaints (zoneless).
        await page.getByRole('button', { name: /re-run translation/ }).click();
        await expect(text).toContainText('Hello — open to a new role?');
    });

    test('a failed translation is visible and recoverable in the browser (#248 verify step 2)', async ({ page }) => {
        // The exact shape the backend's failure paths produce: NO detected
        // language, only the status — the state #298's first template hid.
        const FAILED = {
            ...INTERACTION,
            message: 'Hallo, sind Sie offen für eine neue Stelle?',
            detected_language: null,
            translated_message: null,
            translated_to: null,
            translation_status: 'failed',
        };
        const RECOVERED = {
            ...FAILED,
            detected_language: 'de',
            translated_message: 'Hello, are you open to a new role?',
            translated_to: 'en',
            translation_status: 'done',
        };
        await page.route(`**${API_PREFIX}/admin/interactions/*/translate`, (route) =>
            route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(RECOVERED) })
        );
        await page.route(`**${API_PREFIX}/admin/interactions*`, (route) =>
            route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(page1([FAILED])) })
        );

        await page.goto('/inbox');
        await page.getByText(FAILED.name).click();

        // The failure is stated, the original is what the operator reads…
        await expect(page.getByTestId('translation-bar')).toContainText('translation failed');
        await expect(page.getByTestId('message-text')).toContainText('Hallo, sind Sie offen');

        // …and a re-translate later succeeds, in place (zoneless repaint).
        await page.getByRole('button', { name: /re-run translation/ }).click();
        await expect(page.getByTestId('message-text')).toContainText('Hello, are you open to a new role?');
        await expect(page.getByTestId('translation-bar')).toContainText('machine-translated to en');
    });
});

import { TestBed, ComponentFixture } from '@angular/core/testing';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { of, Subject, throwError } from 'rxjs';
import { Router } from '@angular/router';
import { InboxComponent } from './inbox.component';
import { InteractionsService, Interaction } from '../../../services/interactions.service';
import { OpportunitiesService } from '../../../services/opportunities.service';

function makeInteraction(overrides: Partial<Interaction> = {}): Interaction {
    return {
        id: 'i1',
        source: 'contact_form',
        status: 'new',
        name: 'Rita',
        email: 'rita@a.example',
        company: 'Agency',
        message: 'Hello there',
        payload: null,
        detected_language: null,
        translated_message: null,
        translated_to: null,
        translation_status: null,
        created_at: '2026-09-05T10:00:00Z',
        updated_at: '2026-09-05T10:00:00Z',
        ...overrides,
    };
}

describe('InboxComponent', () => {
    let fixture: ComponentFixture<InboxComponent>;
    let component: InboxComponent;
    let serviceSpy: { list: ReturnType<typeof vi.fn>; updateStatus: ReturnType<typeof vi.fn> };
    let opportunitiesSpy: { promote: ReturnType<typeof vi.fn> };
    let routerSpy: { navigate: ReturnType<typeof vi.fn> };

    beforeEach(async () => {
        serviceSpy = {
            list: vi.fn().mockReturnValue(
                of({ items: [makeInteraction()], total: 1, page: 1, pages: 1 })
            ),
            updateStatus: vi.fn(),
        };
        opportunitiesSpy = { promote: vi.fn() };
        routerSpy = { navigate: vi.fn() };
        await TestBed.configureTestingModule({
            imports: [InboxComponent],
            providers: [
                { provide: InteractionsService, useValue: serviceSpy },
                { provide: OpportunitiesService, useValue: opportunitiesSpy },
                { provide: Router, useValue: routerSpy },
            ],
        }).compileComponents();

        fixture = TestBed.createComponent(InboxComponent);
        component = fixture.componentInstance;
        fixture.detectChanges();
    });

    it('loads the inbox on init', () => {
        expect(serviceSpy.list).toHaveBeenCalledWith({
            status: undefined,
            source: undefined,
            page: 1,
            pageSize: 20,
        });
        expect(component.items.length).toBe(1);
        expect(component.total).toBe(1);
        expect(component.loading).toBe(false);
    });

    it('shows an error when loading fails', () => {
        serviceSpy.list.mockReturnValue(throwError(() => new Error('boom')));
        component.load();
        expect(component.error).toBe('Failed to load the inbox');
        expect(component.loading).toBe(false);
    });

    it('resets to page 1 when filters change', () => {
        component.page = 3;
        component.statusFilter = 'closed';
        component.onFilterChange();
        expect(component.page).toBe(1);
        expect(serviceSpy.list).toHaveBeenLastCalledWith(
            expect.objectContaining({ status: 'closed', page: 1 })
        );
    });

    it('paginates within bounds only', () => {
        component.pages = 3;
        component.goToPage(2);
        expect(component.page).toBe(2);
        component.goToPage(0);
        expect(component.page).toBe(2);
        component.goToPage(4);
        expect(component.page).toBe(2);
        component.goToPage(2); // no-op on same page
        expect(component.page).toBe(2);
    });

    it('toggles message expansion', () => {
        component.toggleExpand('i1');
        expect(component.expandedId).toBe('i1');
        component.toggleExpand('i1');
        expect(component.expandedId).toBeNull();
    });

    it('updates status via the service and reflects the response', () => {
        const row = component.items[0];
        serviceSpy.updateStatus.mockReturnValue(
            of(makeInteraction({ status: 'contacted', updated_at: 'later' }))
        );
        component.setStatus(row, 'contacted');
        expect(serviceSpy.updateStatus).toHaveBeenCalledWith('i1', 'contacted');
        expect(row.status).toBe('contacted');
        expect(row.updated_at).toBe('later');
    });

    it('ignores a status "change" to the same value', () => {
        component.setStatus(component.items[0], 'new');
        expect(serviceSpy.updateStatus).not.toHaveBeenCalled();
    });

    it('promotes to the pipeline and navigates there (#247)', () => {
        opportunitiesSpy.promote.mockReturnValue(of({ id: 'o1' }));
        component.promote(component.items[0]);
        expect(opportunitiesSpy.promote).toHaveBeenCalledWith('i1');
        expect(routerSpy.navigate).toHaveBeenCalledWith(['/pipeline']);
    });

    it('ignores a second promote click while the first is in flight (#279)', () => {
        // Never completes: the request is still open when the second click lands.
        opportunitiesSpy.promote.mockReturnValue(new Subject());
        component.promote(component.items[0]);
        component.promote(component.items[0]);
        expect(opportunitiesSpy.promote).toHaveBeenCalledTimes(1);
    });

    it('releases the latch when promote fails, so the operator can retry', () => {
        opportunitiesSpy.promote.mockReturnValue(throwError(() => new Error('x')));
        component.promote(component.items[0]);
        expect(component.promotingId).toBeNull();

        opportunitiesSpy.promote.mockReturnValue(of({ id: 'o1' }));
        component.promote(component.items[0]);
        expect(opportunitiesSpy.promote).toHaveBeenCalledTimes(2);
    });

    it('disables the button while its own promote is in flight', () => {
        opportunitiesSpy.promote.mockReturnValue(new Subject());
        component.expandedId = 'i1';
        fixture.detectChanges();
        const query = () =>
            (fixture.nativeElement as HTMLElement).querySelector(
                'button[aria-label="promote Rita to pipeline"]'
            ) as HTMLButtonElement;
        expect(query().disabled).toBe(false);

        component.promote(component.items[0]);
        fixture.detectChanges();
        // Re-query: the row re-renders, so a captured node can be stale.
        expect(query().disabled).toBe(true);
        expect(query().textContent).toContain('Promoting');
    });

    it('surfaces promote failures', () => {
        opportunitiesSpy.promote.mockReturnValue(throwError(() => new Error('x')));
        component.promote(component.items[0]);
        expect(component.error).toBe('Failed to promote to the pipeline');
        expect(routerSpy.navigate).not.toHaveBeenCalled();
    });

    it('surfaces status-update failures', () => {
        serviceSpy.updateStatus.mockReturnValue(throwError(() => new Error('nope')));
        component.setStatus(component.items[0], 'closed');
        expect(component.error).toBe('Failed to update the status');
        expect(component.items[0].status).toBe('new');
    });

    it('renders the empty state on a first visit (no interactions, no error)', () => {
        serviceSpy.list.mockReturnValue(of({ items: [], total: 0, page: 1, pages: 1 }));
        fixture = TestBed.createComponent(InboxComponent);
        component = fixture.componentInstance;
        fixture.detectChanges();

        expect(component.items).toEqual([]);
        expect(component.error).toBeNull();
        const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
        expect(text).toContain('No interactions yet');
    });
});

describe('InboxComponent — transparent translation (#248)', () => {
    let fixture: ComponentFixture<InboxComponent>;
    let component: InboxComponent;
    let serviceSpy: Record<'list' | 'updateStatus' | 'rerunTranslation', ReturnType<typeof vi.fn>>;

    function translated(overrides: Partial<Interaction> = {}): Interaction {
        return makeInteraction({
            detected_language: 'de',
            translated_message: 'Hello, are you open?',
            translated_to: 'en',
            translation_status: 'done',
            ...overrides,
        });
    }

    beforeEach(async () => {
        serviceSpy = {
            list: vi.fn().mockReturnValue(of({ items: [translated()], total: 1, page: 1, pages: 1 })),
            updateStatus: vi.fn(),
            rerunTranslation: vi.fn(),
        };
        await TestBed.configureTestingModule({
            imports: [InboxComponent],
            providers: [{ provide: InteractionsService, useValue: serviceSpy }],
        }).compileComponents();
        fixture = TestBed.createComponent(InboxComponent);
        component = fixture.componentInstance;
        fixture.detectChanges();
    });

    it('shows the labeled machine translation by default, original on toggle', () => {
        const i = component.items[0];
        expect(component.displayedMessage(i)).toBe('Hello, are you open?');
        expect(component.showingTranslation(i)).toBe(true);

        component.toggleOriginal(i);
        // The transparency contract: the ORIGINAL is one click away, intact.
        expect(component.displayedMessage(i)).toBe(i.message);
        expect(component.showingTranslation(i)).toBe(false);
        component.toggleOriginal(i);
        expect(component.displayedMessage(i)).toBe('Hello, are you open?');
    });

    it('renders the badge, the machine-generated label and the toggle', () => {
        component.expandedId = component.items[0].id;
        fixture.detectChanges();
        const host = fixture.nativeElement as HTMLElement;
        const bar = host.querySelector('[data-testid="translation-bar"]');
        expect(bar?.textContent).toContain('de');
        expect(bar?.textContent).toContain('machine-translated to en');
        expect(bar?.textContent).toContain('show original');
    });

    it('an untranslated row shows the original with no translation chrome', () => {
        component.items = [makeInteraction()];
        const i = component.items[0];
        expect(component.displayedMessage(i)).toBe(i.message);
        expect(component.showingTranslation(i)).toBe(false);
        component.expandedId = i.id;
        fixture.detectChanges();
        expect(
            (fixture.nativeElement as HTMLElement).querySelector('[data-testid="translation-bar"]'),
        ).toBeNull();
    });

    it('re-translate replaces the row and clears the busy flag', () => {
        const updated = translated({ translated_message: 'Better translation' });
        serviceSpy.rerunTranslation.mockReturnValue(of(updated));
        // A second, unrelated row pins the map's other branch (untouched rows
        // keep identity) — the same lesson the pipeline spec learned.
        const other = makeInteraction({ id: 'other-row' });
        component.items = [translated(), other];
        component.retranslate(component.items[0]);
        expect(serviceSpy.rerunTranslation).toHaveBeenCalledWith(component.items[0].id);
        expect(component.items[0].translated_message).toBe('Better translation');
        expect(component.items[1]).toBe(other);
        expect(component.retranslatingId).toBeNull();
    });

    it('re-translate failure surfaces and unlocks; in-flight clicks are ignored', () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        serviceSpy.rerunTranslation.mockReturnValue(throwError(() => new Error('no')));
        component.retranslate(component.items[0]);
        expect(component.error).toBe('Failed to re-run translation');
        expect(component.retranslatingId).toBeNull();

        component.retranslatingId = 'busy';
        component.retranslate(component.items[0]);
        expect(serviceSpy.rerunTranslation).toHaveBeenCalledTimes(1);
    });

    // #298 review blocker 3: the backend's failure paths produce
    // {detected_language: null, translation_status: 'failed'} — the state the
    // first round's template could not render at all. Pin what the operator
    // actually sees for the states the backend actually produces.
    it('a failed row (null language) shows the error and the re-translate affordance', () => {
        component.items = [
            makeInteraction({ translation_status: 'failed' }),
        ];
        const i = component.items[0];
        expect(component.displayedMessage(i)).toBe(i.message); // original shown
        component.expandedId = i.id;
        fixture.detectChanges();
        const host = fixture.nativeElement as HTMLElement;
        const bar = host.querySelector('[data-testid="translation-bar"]');
        expect(bar).not.toBeNull();
        expect(bar?.textContent).toContain('translation failed');
        const retryBtn = Array.from(bar?.querySelectorAll('button') ?? []).find(
            (b) => b.textContent?.includes('re-translate'),
        );
        expect(retryBtn).toBeTruthy();
        // No badge chrome for a language that was never detected.
        expect(bar?.querySelector('.font-mono')).toBeNull();
    });

    it('a pending row shows progress without translation chrome', () => {
        component.items = [
            makeInteraction({ translation_status: 'pending' }),
        ];
        const i = component.items[0];
        component.expandedId = i.id;
        fixture.detectChanges();
        const bar = (fixture.nativeElement as HTMLElement).querySelector(
            '[data-testid="translation-bar"]',
        );
        expect(bar?.textContent).toContain('translating…');
        expect(component.displayedMessage(i)).toBe(i.message);
    });
});


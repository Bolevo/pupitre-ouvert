// « Mes partitions »: the works of this device, opened from the list of works. Open one, add one
// from its .zip, remove one that was added (confirmed in place), hide an example or put it back.
// A modal dialog of the browser: the rest of the app waits behind it, the focus stays inside,
// Escape or a press beside it closes it.
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { error, hiddenExamples, hideExample, libraryOpen, openWork, removeImportedWork, restoreExamples, work, works } from '../state';
import { pickZip } from './Bars';
import { Icon } from './Icon';
import { tt } from '../i18n';

export function Library() {
  const box = useRef<HTMLDialogElement>(null);
  const [asked, setAsked] = useState<string | null>(null); // the work whose removal is being confirmed
  const close = () => (libraryOpen.value = false);
  useLayoutEffect(() => {
    const d = box.current!;
    // (a browser without modal dialogs, before 2022: the panel is shown all the same, over the app)
    if (typeof d.showModal !== 'function') d.setAttribute('open', '');
    else if (!d.open) d.showModal();
    return () => {
      if (d.open && typeof d.close === 'function') d.close();
    };
  }, []);
  const shown = works.value;
  const hidden = hiddenExamples.value;
  const current = work.value?.pack.id;
  return (
    <dialog
      class="library"
      ref={box}
      aria-labelledby="library-title"
      onClose={close}
      // a press on the backdrop reaches the dialog itself; its content is all in .lib-box
      onClick={(e) => e.target === box.current && close()}
      // the keys of the app (space: play, arrows: measures) are not for what is behind
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div class="lib-box">
        <header class="lib-head">
          <h2 id="library-title">{tt('Mes partitions')}</h2>
          <button class="fiche-close" aria-label={tt('Fermer')} onClick={close}>
            <Icon name="close" />
          </button>
        </header>
        {error.value && (
          <p class="lib-error" role="alert">
            {error.value}
          </p>
        )}
        <div class="lib-body">
          {shown.length === 0 && <p class="lib-none">{tt('Aucune partition dans cette app pour l’instant.')}</p>}
          <ul class="lib-list">
            {shown.map((x) => (
              <li class={x.id === current ? 'on' : ''}>
                <button
                  class="lib-work"
                  aria-current={x.id === current ? 'true' : undefined}
                  onClick={() => {
                    close();
                    if (x.id !== current) void openWork(x.id);
                  }}
                >
                  <b>{x.title}</b>
                  <span>
                    {x.composer}
                    {x.source === 'builtin' && <i>{tt('exemple')}</i>}
                  </span>
                </button>
                {x.source === 'builtin' ? (
                  <button class="lib-act" aria-label={tt('Masquer « {title} »', { title: x.title })} onClick={() => void hideExample(x.id)}>
                    {tt('Masquer')}
                  </button>
                ) : (
                  asked !== x.id && (
                    <button class="lib-act" aria-label={tt('Retirer « {title} »', { title: x.title })} onClick={() => setAsked(x.id)}>
                      {tt('Retirer')}
                    </button>
                  )
                )}
                {asked === x.id && (
                  <div class="lib-ask" role="group" aria-label={tt('Retirer « {title} »', { title: x.title })}>
                    <p>
                      <b>{tt('Retirer « {title} » de cet appareil ?', { title: x.title })}</b> {tt('Ses enregistrements et la progression de son texte sont effacés aussi. Votre fichier .zip n’est pas touché : vous pourrez l’ajouter de nouveau.')}
                    </p>
                    {/* the focus on the harmless answer */}
                    <button class="lib-act" ref={(b) => b?.focus()} onClick={() => setAsked(null)}>
                      {tt('Annuler')}
                    </button>
                    <button
                      class="pop-action"
                      onClick={() => {
                        setAsked(null);
                        void removeImportedWork(x.id);
                      }}
                    >
                      {tt('Retirer')}
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
          {hidden.length > 0 && (
            <>
              <h3>{tt('Exemples masqués')}</h3>
              <ul class="lib-list lib-hidden">
                {hidden.map((x) => (
                  <li>
                    <div class="lib-work">
                      <b>{x.title}</b>
                      <span>{x.composer}</span>
                    </div>
                    <button class="lib-act" aria-label={tt('Remettre « {title} »', { title: x.title })} onClick={() => void restoreExamples(x.id)}>
                      {tt('Remettre')}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
        <footer class="lib-foot">
          <button class="pop-action" onClick={pickZip}>
            {tt('Ajouter une partition (.zip)…')}
          </button>
          <p>{tt('Les partitions ajoutées restent sur cet appareil, dans ce navigateur.')}</p>
        </footer>
      </div>
    </dialog>
  );
}

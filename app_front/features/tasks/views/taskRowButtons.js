/** Autostart and favourite toggle buttons appended to each row of the Tasks dropdown. */
import { t } from '../../../i18n/index.js';
import { isAutoStartExcludedTask, isTaskAutoStart, toggleTaskAutoStart } from '../services/tasksAutostart.js';

function toggleButton({ hidden = false, className, active, onIcon, offIcon, activeClass, titleOn, titleOff, onToggle }) {
  const btn = document.createElement('button');
  btn.hidden = hidden;
  btn.type = 'button';
  btn.className = className;
  const icon = document.createElement('span');
  icon.setAttribute('aria-hidden', 'true');
  btn.appendChild(icon);
  const paint = (isActive) => {
    icon.className = 'mdi ' + (isActive ? onIcon + ' ' + activeClass : offIcon);
    btn.title = isActive ? titleOn : titleOff;
    btn.setAttribute('aria-label', btn.title);
  };
  paint(active);
  btn.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    paint(onToggle());
  });
  return btn;
}

export function appendTaskRowButtons(el, taskLabel, taskFavorites) {
  el.appendChild(toggleButton({
    hidden: isAutoStartExcludedTask(taskLabel),
    className: 'dropdown-fav-btn dropdown-auto-btn',
    active: isTaskAutoStart(taskLabel),
    onIcon: 'mdi-rocket-launch',
    offIcon: 'mdi-rocket-launch-outline',
    activeClass: 'dropdown-auto-btn--active',
    titleOn: t('tasks.disableAutostart'),
    titleOff: t('tasks.enableAutostart'),
    onToggle: () => toggleTaskAutoStart(taskLabel),
  }));
  el.appendChild(toggleButton({
    className: 'dropdown-fav-btn',
    active: taskFavorites.isFavorite(taskLabel),
    onIcon: 'mdi-star',
    offIcon: 'mdi-star-outline',
    activeClass: 'dropdown-fav-btn--active',
    titleOn: t('tasks.favoriteRemove'),
    titleOff: t('tasks.favoriteAdd'),
    onToggle: () => taskFavorites.toggleFavorite(taskLabel),
  }));
}

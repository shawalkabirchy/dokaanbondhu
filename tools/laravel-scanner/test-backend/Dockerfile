# The scanner's Laravel test backend (spec 16.4; D182, D183): a pinned Laravel 12 skeleton with this folder's files
# copied over it, PHP 8.3 with MySQL, and Node 22 so the scanner runs inside the app's folder as an owner runs it.
# Local only: started by run-e2e.sh, never in CI.
FROM php:8.3-cli-bookworm

RUN apt-get update \
  && apt-get install -y --no-install-recommends git unzip libzip-dev \
  && docker-php-ext-install pdo_mysql zip \
  && rm -rf /var/lib/apt/lists/*
COPY --from=composer:2.8 /usr/bin/composer /usr/local/bin/composer
COPY --from=node:22.12.0-bookworm-slim /usr/local/bin/node /usr/local/bin/node

WORKDIR /app
RUN composer create-project laravel/laravel:12.12.2 . --no-interaction --prefer-dist \
  && composer require laravel/framework:12.69.3 --with-all-dependencies --no-interaction

# Our app over the skeleton: routes, controllers, a FormRequest, models, migrations and the seeder.
COPY app/ app/
COPY routes/ routes/
COPY database/ database/
COPY testbackend.env .env
RUN php artisan key:generate --force

CMD ["php", "artisan", "serve", "--host=0.0.0.0", "--port=8000"]

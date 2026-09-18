FROM php:8.2-cli

WORKDIR /app

# The API uses mysqli for every database operation. The CLI base image does
# not include it unless it is compiled explicitly.
RUN docker-php-ext-install mysqli

COPY . /app

EXPOSE 10000

CMD ["sh", "-c", "php -S 0.0.0.0:${PORT:-10000} -t /app/front-end /app/router.php"]

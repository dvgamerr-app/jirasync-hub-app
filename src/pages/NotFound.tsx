import { Link } from "react-router-dom";

const NotFound = () => {
  return (
    <div className="bg-muted flex min-h-screen items-center justify-center">
      <div className="text-center">
        <h1 className="mb-4 text-4xl font-bold">404</h1>
        <p className="text-muted-foreground mb-4 text-xl">Oops! Page not found</p>
        <Link to="/" className="text-primary hover:text-primary/90 underline">
          Return to Home
        </Link>
      </div>
    </div>
  );
};

export default NotFound;
